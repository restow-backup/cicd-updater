import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { q } from "../lib/exec.js";
import { AUTH_REGISTRY, sh, WORK } from "../lib/host.js";
import { type Project, problemOf, type RunView } from "../lib/project.js";
import { deleteManifest } from "../lib/registry.js";
import { StubApp } from "../lib/stub.js";

/**
 * Fetching from a registry that needs a login (design 5.3 fetch, 9.3): access refused vs
 * an image that is gone (classified only when access was confirmed), an optional image a
 * release leaves out, and an image whose version label does not match the release.
 */

let app: StubApp;
let project: Project;

function imageErrors(result: Awaited<ReturnType<Project["schedule"]>>): (string | null)[] {
  const problem = problemOf(result);
  expect(problem.code).toBe("release_unverifiable");
  return (problem.checks as { images: { error: string | null }[] }).images.map(
    (image) => image.error,
  );
}

beforeAll(async () => {
  app = await StubApp.create({
    name: "fetch",
    registry: AUTH_REGISTRY,
    edge: true,
    edgeOptional: true,
    updater: (config) => {
      config.docker = { minFreeMb: 64, registryAuthFile: `${app.project.dir}/registry-auth.json` };
    },
  });
  await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
  await app.release({ version: "1.1.0", migration: 1 });
  await app.release({ version: "1.2.0", migration: 1 });
  await app.release({ version: "1.3.0", migration: 1 }, { withEdge: false });
  await sh(
    `mkdir -p ${q(app.project.dir)} && cp ${WORK}/pki/registry-auth.json ${q(app.project.dir)}/registry-auth.json`,
  );
  project = await app.install("1.0.0");
});

afterAll(async () => {
  await project?.down();
});

afterEach(async () => {
  await project?.settle();
});

describe("a registry with a login", () => {
  it("installs with the credentials of docker.registryAuthFile (pull and cosign verify)", async () => {
    const run: RunView = await project.update("1.1.0");
    expect(run.outcome).toBe("succeeded");
    expect(run.verification).toEqual({ signatures: "verified", digests: "verified" });
  });

  it("classifies refused access as registry_unauthorized", async () => {
    const good = `${project.dir}/registry-auth.json`;
    await sh(
      `cp ${q(good)} ${q(good)}.good && printf '{"auths":{"${AUTH_REGISTRY}":{"auth":"%s"}}}' "$(printf 'e2e:wrong' | base64)" > ${q(good)}`,
    );
    try {
      expect(imageErrors(await project.schedule("1.2.0"))).toEqual([
        "fetch.registry_unauthorized",
        "fetch.registry_unauthorized",
      ]);
    } finally {
      await sh(`mv ${q(good)}.good ${q(good)}`);
    }
  });

  it("classifies a deleted image as image_not_found when access is confirmed", async () => {
    const digest = app.releases.get("1.2.0")?.images.app?.digest ?? "";
    await deleteManifest("e2e/fetch-app", digest, AUTH_REGISTRY);
    const env = await project.env();
    const scheduled = await project.schedule("1.2.0");
    if (scheduled.code === 0) {
      // cosign verified the signature (it lives under its own tag); the pull finds no image.
      const run = await project.finished();
      expect(run.failure?.code).toBe("fetch.image_not_found");
      expect(run.outcome).toBe("unchanged");
      expect(await project.env()).toBe(env);
    } else {
      expect(imageErrors(scheduled)[0]).toBe("fetch.image_not_found");
    }
  });
});

describe("what a release carries", () => {
  it("an optional service the release leaves out keeps running as it is", async () => {
    const edgeBefore = await project.serviceImage("edge");
    const run = await project.update("1.3.0");
    expect(run.outcome).toBe("succeeded");
    expect(await project.serviceImage("api")).toBe(app.ref("1.3.0"));
    expect(await project.serviceImage("edge")).toBe(edgeBefore);
    expect(await project.envValue("EDGE_IMAGE")).toBe(app.ref("1.1.0", "edge"));
  });

  it("refuses an image whose version label is not the release's version (fetch, unchanged)", async () => {
    const env = await project.env();
    // A signed 1.4.0 document that names the images of 1.1.0 (labelled 1.1.0). The tag
    // field says 1.4.0 (the release tools refuse another tag); the digest decides the pull.
    const old = app.releases.get("1.1.0")?.images ?? {};
    const reuse = Object.fromEntries(
      Object.entries(old).map(([key, image]) => [key, { ...image, tag: "1.4.0" }]),
    );
    await app.release({ version: "1.4.0" }, { reuse, withEdge: true });
    const run = await project.update("1.4.0");
    expect(run.failure?.code).toBe("fetch.version_label_mismatch");
    expect(run.outcome).toBe("unchanged");
    expect(await project.env()).toBe(env);
  });
});
