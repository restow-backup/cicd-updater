import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY, readFile, sh, writeFile } from "../lib/host.js";
import { type Project, problemOf } from "../lib/project.js";
import { deleteManifest, tags } from "../lib/registry.js";
import { StubApp } from "../lib/stub.js";

/**
 * Trust (design 10.7): key mode end to end with cosign 3 against distribution/registry
 * v3, the API's authentication and the public status, everything that must be refused
 * (unsigned, tampered, swapped, another key), keyless refusing an unsigned release, and
 * none mode recorded and shown.
 */

let app: StubApp;
let project: Project;

beforeAll(async () => {
  app = await StubApp.create({ name: "trust", edge: true });
  await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
  await app.release({ version: "1.1.0", migration: 1, migrateOnStart: true });
  project = await app.install("1.0.0");
});

afterAll(async () => {
  await project?.down();
});

describe("key mode", () => {
  it("stores cosign 3 signatures in the referrers tag schema of registry v3", async () => {
    const digest = app.releases.get("1.1.0")?.images.app?.digest ?? "";
    const tags = (
      await sh(`wget -q -O - --no-check-certificate https://${REGISTRY}/v2/e2e/trust-app/tags/list`)
    ).stdout;
    expect(tags).toContain(digest.replace(":", "-"));
    // No referrers API in registry v3: cosign fell back to the tag schema.
    const referrers = await sh(
      `wget -q -O - --no-check-certificate https://${REGISTRY}/v2/e2e/trust-app/referrers/${digest}`,
      { allowFail: true },
    );
    expect(referrers.code).not.toBe(0);
  });

  it("verifies and installs a release signed with the configured key", async () => {
    const before = await project.state();
    expect(before.trust.mode).toBe("key");
    expect(before.running.version).toBe("1.0.0");
    const run = await project.update("1.1.0");
    expect(run.failure).toBeNull();
    expect(run.outcome).toBe("succeeded");
    expect(run.trustMode).toBe("key");
    expect(run.verification).toEqual({ signatures: "verified", digests: "verified" });
    expect(await project.envValue("APP_IMAGE")).toBe(app.ref("1.1.0"));
    expect(await project.envValue("EDGE_IMAGE")).toBe(app.ref("1.1.0", "edge"));
    expect(await project.serviceImage("api")).toBe(app.ref("1.1.0"));
    expect((await project.state()).running.version).toBe("1.1.0");
    await project.ack();
  });
});

describe("authentication and the public status", () => {
  it("answers the API only with the token, and the public status without one", async () => {
    const token = await project.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const anonymous = await project.http("api", "http://updater:8090/v1/state");
    expect(anonymous.status).toBe(401);
    const wrong = await project.http("api", "http://updater:8090/v1/state", "x".repeat(43));
    expect(wrong.status).toBe(401);
    const authorized = await project.http("api", "http://updater:8090/v1/state", token);
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body).phase).toBe("idle");

    const pub = await project.http("api", "http://updater:8090/public/v1/status");
    expect(pub.status).toBe(200);
    const status = JSON.parse(pub.body) as Record<string, unknown>;
    expect(status.phase).toBe("idle");
    expect(status).not.toHaveProperty("targetVersion");
    expect(pub.body).not.toContain("1.1.0");
    for (const body of [anonymous.body, wrong.body, authorized.body, pub.body]) {
      expect(body).not.toContain(token);
    }
    const logs = await project.compose(["logs", "--no-color", "updater"]);
    expect(logs.stdout + logs.stderr).not.toContain(token);
  });
});

describe("refused releases", () => {
  it("refuses unsigned images when scheduling", async () => {
    await app.release({ version: "1.2.0", migration: 1 }, { signImages: false });
    const problem = problemOf(await project.schedule("1.2.0"));
    expect(problem.code).toBe("release_unverifiable");
    const images = (problem.checks as { images: { key: string; error: string | null }[] }).images;
    expect(images.map((image) => [image.key, image.error])).toEqual([
      ["app", "fetch.signature_missing"],
      ["edge", "fetch.signature_missing"],
    ]);
    expect((await project.state()).phase).toBe("idle");
  });

  it("refuses images signed with another key when scheduling", async () => {
    await app.release({ version: "1.3.0", migration: 1 }, { imageSigner: "other" });
    const problem = problemOf(await project.schedule("1.3.0"));
    expect(problem.code).toBe("release_unverifiable");
    const images = (problem.checks as { images: { error: string | null }[] }).images;
    expect(images.map((image) => image.error)).toEqual([
      "fetch.signature_invalid",
      "fetch.signature_invalid",
    ]);
  });

  it("fails in fetch when a signature disappears after scheduling (unchanged)", async () => {
    const release = await app.release({ version: "1.9.0", migration: 1 });
    const scheduled = await project.schedule("1.9.0", ["--in", "20s"]);
    expect(scheduled.code).toBe(0);
    const digest = release.images.app?.digest ?? "";
    await deleteManifest("e2e/trust-app", digest.replace(":", "-"));
    expect(await tags("e2e/trust-app")).not.toContain(digest.replace(":", "-"));
    const env = await project.env();
    const run = await project.finished();
    expect(run.outcome).toBe("unchanged");
    expect(run.failure?.code).toBe("fetch.signature_missing");
    expect(run.failure?.step).toBe("fetch");
    expect(await project.env()).toBe(env);
    expect(await project.serviceImage("api")).toBe(app.ref("1.1.0"));
    await project.ack();
  });

  it("refuses a release.json signed with another key", async () => {
    await app.release({ version: "1.4.0", migration: 1 }, { signer: "other" });
    const refused = await project.schedule("1.4.0");
    expect(refused.code).toBe(1);
    const problem = problemOf(refused);
    expect(problem.code).toBe("release_unverifiable");
    expect(problem.detail).toContain("signature_invalid");
    expect((await project.state()).phase).toBe("idle");
  });

  it("refuses a release.json changed after signing", async () => {
    const release = await app.release({ version: "1.5.0", migration: 1 });
    const file = `${project.feed}/${release.document}`;
    const document = JSON.parse(await readFile(file));
    document.notesUrl = "https://attacker.example/notes";
    await writeFile(file, JSON.stringify(document, null, 2));
    const problem = problemOf(await project.schedule("1.5.0"));
    expect(problem.code).toBe("release_unverifiable");
    expect(problem.detail).toContain("signature_invalid");
  });

  it("refuses a copy with the services' digests swapped", async () => {
    const release = await app.release({ version: "1.6.0", migration: 1 });
    const file = `${project.feed}/${release.document}`;
    const document = JSON.parse(await readFile(file));
    const { app: appImage, edge } = document.images;
    [appImage.digest, edge.digest] = [edge.digest, appImage.digest];
    await writeFile(file, JSON.stringify(document, null, 2));
    const problem = problemOf(await project.schedule("1.6.0"));
    expect(problem.code).toBe("release_unverifiable");
    expect(problem.detail).toContain("signature_invalid");
  });

  it("refuses a release.json without a bundle", async () => {
    await app.release({ version: "1.7.0", migration: 1 }, { signDocument: false });
    const problem = problemOf(await project.schedule("1.7.0"));
    expect(problem.code).toBe("release_unverifiable");
    expect(problem.detail).toContain("signature_missing");
  });
});

describe("other trust modes", () => {
  it("keyless refuses an unsigned release", async () => {
    await project.reconfigure((config) => {
      config.trust = {
        mode: "keyless",
        keyless: { github: { repository: "acme/stub", workflow: ".github/workflows/release.yml" } },
      };
    });
    expect((await project.state()).trust.mode).toBe("keyless");
    const problem = problemOf(await project.schedule("1.7.0"));
    expect(problem.code).toBe("release_unverifiable");
    expect(problem.detail).toContain("signature_missing");
  });

  it("none mode installs unsigned releases and records that nothing was checked", async () => {
    await project.reconfigure((config) => {
      config.trust = { mode: "none", none: { acknowledgeUnsigned: true } };
    });
    await app.release({ version: "1.8.0", migration: 1 }, { signing: "none" });
    const state = await project.state();
    expect(state.trust.mode).toBe("none");
    const run = await project.update("1.8.0");
    expect(run.outcome).toBe("succeeded");
    expect(run.trustMode).toBe("none");
    expect(run.release.document).toBe("not_checked");
    expect(run.verification.signatures).toBe("not_checked");
    const events = JSON.parse(
      (await project.http("api", "http://updater:8090/v1/events?limit=500", await project.token()))
        .body,
    ) as { events: { type: string; data?: Record<string, unknown> }[] };
    expect(JSON.stringify(events)).toContain('"trustMode":"none"');
    await project.ack();
  });
});
