import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHarness,
  type FakeDockerOps,
  type Harness,
  OLD_APP,
  scheduleRequest,
  settle,
  waitForCall,
} from "../src/testing.js";

let h: Harness;
const all: Harness[] = [];

beforeEach(async () => {
  h = await createHarness();
  h.publish("1.1.0");
  all.push(h);
});

afterEach(async () => {
  for (const harness of all.splice(0)) {
    await harness.cleanup();
  }
});

async function restart(): Promise<Harness> {
  const next = await h.restart();
  all.push(next);
  h = next;
  await next.engine.init();
  return next;
}

/** Leave the run hanging inside an operation, as if the process had been killed there. */
function hangAt(ops: FakeDockerOps, operation: "stop" | "pull" | "up" | "pruneImages"): void {
  (ops as unknown as Record<string, unknown>)[operation] = () => {
    ops.calls.push(operation);
    return new Promise<never>(() => undefined);
  };
}

describe("resume after the sidecar restarted (design 5.8)", () => {
  it("re-arms a scheduled run and starts it at its time", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 300 }), "api");
    const restarted = await restart();
    expect(restarted.engine.view().phase).toBe("scheduled");
    expect(restarted.clock.pendingTimers).toBe(1);
    restarted.clock.advance(299_000);
    expect(restarted.engine.view().phase).toBe("scheduled");
    restarted.clock.advance(1000);
    await settle(restarted.engine);
    expect(restarted.engine.view().run?.outcome).toBe("succeeded");
  });

  it("starts a run that is overdue within the tolerance right away", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
    await h.engine.shutdown();
    h.clock.advance(60_000 + 600_000 - 1000);
    const restarted = await restart();
    await settle(restarted.engine);
    expect(restarted.engine.view().run?.outcome).toBe("succeeded");
  });

  it("does not start a run that is later than the tolerance: missed_start, unchanged", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
    await h.engine.shutdown();
    h.clock.advance(60_000 + 600_000 + 1000);
    const restarted = await restart();
    const view = restarted.engine.view();
    expect(view.phase).toBe("failed");
    expect(view.run).toMatchObject({
      outcome: "unchanged",
      failure: { code: "missed_start", step: null },
    });
    expect(view.run?.steps.every((step) => step.status === "skipped")).toBe(true);
    expect(restarted.ops.callsTo("pull")).toEqual([]);
    expect(view.events.map((event) => event.action)).toEqual(["update.scheduled", "update.failed"]);
  });

  it("a run interrupted before the point of no return ends unchanged and runs nothing", async () => {
    hangAt(h.ops, "pull");
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await waitForCall(h.ops, "pull");
    expect(h.engine.view().phase).toBe("running");
    const callsBefore = h.ops.calls.length;
    const restarted = await restart();
    const view = restarted.engine.view();
    expect(view.phase).toBe("failed");
    expect(view.run).toMatchObject({
      outcome: "unchanged",
      failure: { code: "interrupted", step: "fetch" },
      message: { code: "run.interrupted" },
      recovery: null,
    });
    expect(view.run?.steps.find((step) => step.id === "fetch")?.status).toBe("failed");
    // Only the leftover cleanup ran: no service was started or stopped.
    expect(
      restarted.ops.calls.slice(callsBefore).filter((call) => /^(up|stop) /.test(call)),
    ).toEqual([]);
  });

  it("a run interrupted after the point of no return needs attention and names the backup", async () => {
    hangAt(h.ops, "stop");
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await waitForCall(h.ops, "stop");
    expect(h.engine.view().run?.step).toBe("stop");
    const backup = (await h.backups.list())[0];
    expect(backup).toBeDefined();
    const restarted = await restart();
    const view = restarted.engine.view();
    expect(view.run).toMatchObject({
      outcome: "needs_attention",
      failure: { code: "interrupted", step: "stop", schemaChanged: null },
    });
    expect(view.run?.recovery).toMatchObject({
      backup: { file: backup?.file, bytes: backup?.bytes, type: "postgres" },
      fromVersion: "1.0.0",
      previousImages: { api: OLD_APP },
    });
    expect(restarted.ops.calls.filter((call) => /^(up|stop) /.test(call))).toEqual([]);
    expect(view.events.map((event) => event.action)).toEqual([
      "update.scheduled",
      "update.started",
      "update.failed",
    ]);
  });

  it("a run interrupted while starting needs attention; the previous lines were persisted first", async () => {
    hangAt(h.ops, "up");
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await waitForCall(h.ops, "up");
    const restarted = await restart();
    const run = restarted.engine.view().run;
    expect(run?.outcome).toBe("needs_attention");
    expect(run?.recovery?.previousEnv.APP_IMAGE).toEqual({
      present: true,
      line: `APP_IMAGE=${OLD_APP}`,
    });
    const raw = JSON.parse(await fs.readFile(`${restarted.stateDir}/status.json`, "utf8")) as {
      runContext: { applyAttempted: boolean; envWritten: boolean; ponrReached: boolean };
    };
    expect(raw.runContext).toMatchObject({
      applyAttempted: true,
      envWritten: true,
      ponrReached: true,
    });
  });

  it("a run interrupted during finish counts as succeeded (health had passed)", async () => {
    hangAt(h.ops, "pruneImages");
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await waitForCall(h.ops, "pruneImages");
    expect(h.engine.view().run?.step).toBe("finish");
    const restarted = await restart();
    const view = restarted.engine.view();
    expect(view.phase).toBe("succeeded");
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.events.at(-1)).toMatchObject({
      action: "update.succeeded",
      details: { resumed: true },
    });
  });

  it("keeps a finished run readable after a restart and continues journal ids", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await settle(h.engine);
    const before = h.engine.view().events.map((event) => event.id);
    const restarted = await restart();
    expect(restarted.engine.view().phase).toBe("succeeded");
    await restarted.engine.acknowledge(restarted.engine.view().run?.id ?? "", {
      id: null,
      label: "ops",
      via: "cli",
    });
    restarted.publish("1.2.0");
    restarted.clock.advance(60_000);
    await restarted.engine.schedule(scheduleRequest("1.2.0"), "api");
    await settle(restarted.engine);
    const after = restarted.engine.view().events.map((event) => event.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect([...after].sort()).toEqual(after);
    expect(new Set(after).size).toBe(after.length);
  });

  it("removes leftovers at start: helper containers, partial backups and source trees", async () => {
    await h.backups.ensureDirectory();
    const partial = `${h.backups.directory}/notes-20261101-120000Z-1.0.0-to-1.1.0.pgdump.partial`;
    await fs.writeFile(partial, "PGDMP");
    await fs.writeFile(`${h.backups.directory}/operator-notes.txt`, "mine");
    const restarted = await restart();
    expect(restarted.ops.callsTo("removeLeftovers")).toHaveLength(1);
    expect(restarted.source.purges).toBeGreaterThanOrEqual(1);
    await expect(fs.access(partial)).rejects.toThrow();
    expect(await fs.readFile(`${h.backups.directory}/operator-notes.txt`, "utf8")).toBe("mine");
  });

  it("continues idle when status.json is corrupt and keeps the broken file", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await settle(h.engine);
    await h.store.flush();
    await fs.writeFile(`${h.stateDir}/status.json`, '{"schemaVersion":1,"phase":"runn');
    const restarted = await restart();
    const view = restarted.engine.view();
    expect(view.phase).toBe("idle");
    expect(view.history).toEqual([]);
    expect(restarted.store.recoveredFrom).toMatch(/^status\.json\.corrupt-\d+$/);
    expect(
      restarted.logger.lines.some(
        (line) => line.startsWith("ERROR") && line.includes("status.json"),
      ),
    ).toBe(true);
  });

  it("stops at the next check point on shutdown and leaves the run for the next start", async () => {
    h.appAt("1.1.0", { kind: "ready", afterPolls: 1000, reportsVersion: "1.1.0" });
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await waitForCall(h.ops, "up");
    await h.engine.shutdown();
    await h.engine.settled();
    expect(h.engine.view().phase).toBe("running");
    const restarted = await restart();
    expect(restarted.engine.view().run).toMatchObject({
      outcome: "needs_attention",
      failure: { code: "interrupted" },
    });
  });
});
