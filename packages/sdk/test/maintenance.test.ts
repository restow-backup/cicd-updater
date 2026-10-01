import { readFileSync } from "node:fs";
import type { PublicStatus } from "@cicd-updater/protocol";
import { describe, expect, it } from "vitest";
import {
  type MaintenanceSnapshot,
  MaintenanceTracker,
  pollMaintenance,
  RELOAD_DELAY_MS,
} from "../src/maintenance.js";
import * as react from "../src/react.js";

const NOW = Date.parse("2026-11-02T10:00:00Z");

function status(overrides: Partial<PublicStatus> = {}): PublicStatus {
  return {
    phase: "idle",
    runId: null,
    outcome: null,
    startsAt: null,
    startedAt: null,
    finishedAt: null,
    step: null,
    steps: [],
    progress: 0,
    message: null,
    failureCode: null,
    serverTime: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

/** Timers that run only when the test says so. */
function manualTimers() {
  let clock = NOW;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  return {
    now: () => clock,
    setTimer: (callback: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { at: clock + ms, callback });
      return id;
    },
    clearTimer: (id: unknown) => {
      pending.delete(id as number);
    },
    pending,
    /** Advance the clock and run what is due; returns the delays that ran. */
    async advance(ms: number) {
      clock += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= clock) {
          pending.delete(id);
          timer.callback();
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("/maintenance (no React)", () => {
  it("imports nothing from React", () => {
    const source = readFileSync(new URL("../src/maintenance.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["@cicd-updater/protocol"]);
    expect(source).toMatch(/^import type /m);
  });

  it("is re-exported unchanged by /react", () => {
    expect(react.MaintenanceTracker).toBe(MaintenanceTracker);
    expect(react.pollMaintenance).toBe(pollMaintenance);
  });

  it("polls slowly while idle, fast while a run is active, and falls back to the public status", async () => {
    const timers = manualTimers();
    const snapshots: MaintenanceSnapshot[] = [];
    let answer: PublicStatus | Error = status();
    let publicCalls = 0;
    const stop = pollMaintenance({
      fetchMaintenance: async () => {
        if (answer instanceof Error) throw answer;
        return answer;
      },
      fetchPublicStatus: async () => {
        publicCalls += 1;
        return status({ phase: "running", runId: "r-1", serverTime: "2026-11-02T10:00:31.000Z" });
      },
      onChange: (snapshot) => snapshots.push(snapshot),
      onReload: () => undefined,
      ...timers,
    });
    await timers.advance(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.phase).toBe("idle");
    expect([...timers.pending.values()][0]?.at).toBe(NOW + 30_000);

    answer = new Error("the app is down");
    await timers.advance(30_000);
    expect(publicCalls).toBe(1);
    expect(snapshots[1]).toMatchObject({ phase: "running", apiReachable: false });
    expect([...timers.pending.values()][0]?.at).toBe(NOW + 32_000);

    stop();
    expect(timers.pending.size).toBe(0);
    await timers.advance(60_000);
    expect(snapshots).toHaveLength(2);
  });

  it("reloads once, after the delay, when a run it saw running succeeds", async () => {
    const timers = manualTimers();
    let reloads = 0;
    let answer = status({ phase: "running", runId: "r-2" });
    const stop = pollMaintenance({
      fetchMaintenance: async () => answer,
      onChange: () => undefined,
      onReload: () => {
        reloads += 1;
      },
      activePollMs: 1000,
      ...timers,
    });
    await timers.advance(0);
    answer = status({ phase: "succeeded", runId: "r-2", outcome: "succeeded" });
    await timers.advance(1000);
    expect(reloads).toBe(0);
    await timers.advance(RELOAD_DELAY_MS);
    expect(reloads).toBe(1);
    await timers.advance(30_000);
    await timers.advance(30_000);
    expect(reloads).toBe(1);
    stop();
  });

  it("drops a pending reload when stopped", async () => {
    const timers = manualTimers();
    let reloads = 0;
    let answer = status({ phase: "running", runId: "r-3" });
    const stop = pollMaintenance({
      fetchMaintenance: async () => answer,
      onChange: () => undefined,
      onReload: () => {
        reloads += 1;
      },
      activePollMs: 1000,
      ...timers,
    });
    await timers.advance(0);
    answer = status({ phase: "succeeded", runId: "r-3", outcome: "succeeded" });
    await timers.advance(1000);
    stop();
    await timers.advance(RELOAD_DELAY_MS);
    expect(reloads).toBe(0);
  });
});

describe("admin texts in /messages", () => {
  it("have the same keys and placeholders in every language", async () => {
    const { adminCatalogs, adminEn } = await import("../src/messages.js");
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [locale, catalog] of Object.entries(adminCatalogs)) {
      expect(catalog.locale).toBe(locale);
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(adminEn).sort());
      for (const [key, text] of Object.entries(catalog)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
        expect(placeholders(text), `${locale}.${key}`).toEqual(
          placeholders(adminEn[key as keyof typeof adminEn]),
        );
      }
    }
  });

  it("pick a language and format lead times", async () => {
    const { adminMessagesFor, formatLeadTime, adminDe, adminEn } = await import(
      "../src/messages.js"
    );
    expect(adminMessagesFor("de-AT")).toBe(adminDe);
    expect(adminMessagesFor("fr")).toBe(adminEn);
    expect(adminMessagesFor(null)).toBe(adminEn);
    expect([0, 60, 300, 1800, 3600, 7200, 5400].map((s) => formatLeadTime(adminEn, s))).toEqual([
      "now",
      "in 1 minute",
      "in 5 minutes",
      "in 30 minutes",
      "in 1 hour",
      "in 2 hours",
      "in 90 minutes",
    ]);
    expect(formatLeadTime(adminDe, 900)).toBe("in 15 Minuten");
  });
});
