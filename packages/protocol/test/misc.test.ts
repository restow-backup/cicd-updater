import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BLOCKER_CODES,
  de,
  describeCode,
  describeKeyless,
  en,
  FAILURE_CODES,
  FEED_ERROR_CODES,
  formatMessage,
  idlePublicStatus,
  initialSteps,
  isValidJsonPath,
  isValidTagPattern,
  jsonSchemas,
  keylessIdentity,
  MESSAGE_CODES,
  messagesFor,
  openApiDocument,
  PROBLEM_CODES,
  progressOf,
  publicStatusOf,
  REFUSAL_CODES,
  type Run,
  renderTag,
  STEP_IDS,
  STEP_WEIGHTS,
  scalarText,
  stepOfFailure,
  stepOrder,
  valueAtPath,
  versionFromTag,
  WARNING_CODES,
} from "../src/index.js";

describe("json path", () => {
  it("accepts the restricted grammar only", () => {
    for (const ok of ["$.version", "$.a.b[0].c", "$[3]", "$._x-y"]) {
      expect(isValidJsonPath(ok), ok).toBe(true);
    }
    for (const bad of [
      "$",
      "version",
      "$..a",
      "$.*",
      "$[*]",
      "$['a']",
      "$.a[-1]",
      "$.1a",
      `$${".a".repeat(11)}`,
    ]) {
      expect(isValidJsonPath(bad), bad).toBe(false);
    }
  });

  it("reads values and reports missing ones as undefined", () => {
    const document = {
      version: "1.2.0",
      checks: [{ db: "ok" }],
      n: 3,
      flag: false,
      nested: { "x-y": 1 },
    };
    expect(valueAtPath(document, "$.version")).toBe("1.2.0");
    expect(valueAtPath(document, "$.checks[0].db")).toBe("ok");
    expect(valueAtPath(document, "$.checks[1].db")).toBeUndefined();
    expect(valueAtPath(document, "$.nested.x-y")).toBe(1);
    expect(valueAtPath(document, "$.toString")).toBeUndefined();
    expect(valueAtPath(document, "$.version.length")).toBeUndefined();
    expect(scalarText(valueAtPath(document, "$.n"))).toBe("3");
    expect(scalarText(valueAtPath(document, "$.flag"))).toBe("false");
    expect(scalarText(valueAtPath(document, "$.checks"))).toBeNull();
  });
});

describe("tags and keyless identities", () => {
  it("renders and reverses tag patterns", () => {
    expect(isValidTagPattern("v{version}")).toBe(true);
    expect(isValidTagPattern("{version}")).toBe(true);
    expect(isValidTagPattern("v{version}{version}")).toBe(false);
    expect(isValidTagPattern("v version {version}")).toBe(false);
    expect(renderTag("v{version}", "1.4.0")).toBe("v1.4.0");
    expect(renderTag("notes/v{version}", "1.4.0-rc.1")).toBe("notes/v1.4.0-rc.1");
    expect(() => renderTag("v{version}", "v1.4.0")).toThrow();
    expect(versionFromTag("v{version}", "v1.4.0")).toBe("1.4.0");
    expect(versionFromTag("v{version}", "1.4.0")).toBeNull();
    expect(versionFromTag("v{version}", "v1.4")).toBeNull();
    expect(versionFromTag("v{version}", "v1.4.0+build")).toBeNull();
    expect(versionFromTag("notes/v{version}", "notes/v2.0.0")).toBe("2.0.0");
  });

  it("builds the exact GitHub identity with the workflow checks", () => {
    const identity = keylessIdentity(
      { github: { repository: "acme/notes", workflow: ".github/workflows/release.yml" } },
      "v1.4.0",
      "1.4.0",
    );
    expect(identity).toEqual({
      issuer: "https://token.actions.githubusercontent.com",
      identity: "https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0",
      github: { repository: "acme/notes", ref: "refs/tags/v1.4.0", trigger: "push" },
    });
  });

  it("builds GitLab and generic identities", () => {
    expect(
      keylessIdentity(
        {
          gitlab: { host: "gitlab.com", project: "acme/sub/notes", ciConfigPath: ".gitlab-ci.yml" },
        },
        "v1.4.0",
        "1.4.0",
      ),
    ).toEqual({
      issuer: "https://gitlab.com",
      identity: "https://gitlab.com/acme/sub/notes//.gitlab-ci.yml@refs/tags/v1.4.0",
      github: null,
    });
    expect(
      keylessIdentity(
        {
          issuer: "https://issuer.example.com",
          identityTemplate: "https://ci.example.com/notes/{version}@{tag}",
        },
        "v1.4.0",
        "1.4.0",
      ).identity,
    ).toBe("https://ci.example.com/notes/1.4.0@v1.4.0");
    expect(() => keylessIdentity({}, "v1.4.0", "1.4.0")).toThrow();
    expect(() =>
      keylessIdentity(
        { github: { repository: "a/b", workflow: ".github/workflows/r.yml" } },
        "v1 .4",
        "1.4.0",
      ),
    ).toThrow();
    expect(
      describeKeyless(
        { github: { repository: "a/b", workflow: ".github/workflows/r.yml" } },
        "v{version}",
      ),
    ).toBe("https://github.com/a/b/.github/workflows/r.yml@refs/tags/v<version>");
  });
});

describe("steps and progress", () => {
  it("has weights that sum to 100 and two orders", () => {
    expect(Object.values(STEP_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(stepOrder(false)).toEqual([...STEP_IDS]);
    expect(stepOrder(true).slice(0, 4)).toEqual(["prepare", "fetch", "stop", "backup"]);
  });

  it("counts done and skipped steps fully and the running step half", () => {
    const steps = initialSteps(stepOrder(false), new Set(["migrate", "smoke"]));
    expect(progressOf(steps)).toBe(15);
    steps[0] = { ...(steps[0] as (typeof steps)[number]), status: "done" };
    steps[1] = { ...(steps[1] as (typeof steps)[number]), status: "running" };
    expect(progressOf(steps)).toBe(35);
  });

  it("maps failure codes to their step", () => {
    expect(stepOfFailure("fetch.digest_mismatch")).toBe("fetch");
    expect(stepOfFailure("interrupted")).toBeNull();
  });
});

describe("public status", () => {
  const run = {
    id: "r-1790000000000-abcd",
    targetVersion: "1.4.0",
    fromVersion: "1.3.0",
    startsAt: "2026-11-02T18:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    outcome: null,
    step: null,
    steps: initialSteps(stepOrder(false), new Set()),
    progress: 0,
    message: {
      code: "run.scheduled",
      params: { version: "1.4.0", startsAt: "2026-11-02T18:00:00.000Z" },
    },
    failure: null,
  } as unknown as Run;
  const now = new Date("2026-11-02T17:00:00.000Z");

  it("hides versions unless showVersions", () => {
    const hidden = publicStatusOf("scheduled", run, now);
    expect(hidden.message).toEqual({
      code: "run.scheduled",
      params: { startsAt: "2026-11-02T18:00:00.000Z" },
    });
    expect(JSON.stringify(hidden)).not.toContain("1.4.0");
    expect(JSON.stringify(hidden)).not.toContain("1.3.0");
    expect(hidden).not.toHaveProperty("targetVersion");
    const shown = publicStatusOf("scheduled", run, now, true);
    expect(shown.targetVersion).toBe("1.4.0");
    expect(shown.message?.params.version).toBe("1.4.0");
  });

  it("is idle without a run", () => {
    expect(publicStatusOf("idle", null, now)).toEqual(idlePublicStatus(now));
  });
});

describe("message catalogs", () => {
  it("translate every code in English and German", () => {
    for (const catalog of [en, de]) {
      for (const code of MESSAGE_CODES) expect(catalog.messages[code], code).toBeTruthy();
      for (const code of FAILURE_CODES) expect(catalog.failures[code], code).toBeTruthy();
      for (const code of BLOCKER_CODES) expect(catalog.blockers[code], code).toBeTruthy();
      for (const code of WARNING_CODES) expect(catalog.warnings[code], code).toBeTruthy();
      for (const code of REFUSAL_CODES) expect(catalog.refusals[code], code).toBeTruthy();
      for (const code of PROBLEM_CODES) expect(catalog.problems[code], code).toBeTruthy();
      for (const code of FEED_ERROR_CODES) expect(catalog.feedErrors[code], code).toBeTruthy();
      for (const code of STEP_IDS) expect(catalog.steps[code], code).toBeTruthy();
    }
  });

  it("interpolates parameters and renders unknown codes generically", () => {
    expect(formatMessage(en, { code: "run.succeeded", params: { version: "1.4.0" } })).toBe(
      "Version 1.4.0 is now running.",
    );
    expect(formatMessage(de, { code: "step.fetch.pulling", params: { index: 1, total: 2 } })).toBe(
      "Abbild 1 von 2 wird heruntergeladen.",
    );
    expect(formatMessage(en, { code: "run.from_the_future", params: {} })).toBe(
      "Status code run.from_the_future",
    );
    expect(describeCode(de, "failures", "health.new_reason")).toBe("Statuscode health.new_reason");
    expect(describeCode(en, "failures", "toString")).toBe("Status code toString");
    expect(messagesFor("de-AT").locale).toBe("de");
    expect(messagesFor("fr").locale).toBe("en");
  });
});

describe("generated contracts", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  (addFormats as unknown as (ajv: Ajv2020) => void)(ajv);

  it("produces JSON Schemas that compile and accept the example configuration", () => {
    const schemas = jsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      "feed-index.schema.json",
      "public-status.schema.json",
      "release.schema.json",
      "status.schema.json",
      "updater-config.schema.json",
    ]);
    const validate = ajv.compile(schemas["updater-config.schema.json"] as object);
    const example = parse(
      readFileSync(new URL("./fixtures/updater.yaml", import.meta.url), "utf8"),
    );
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...example, unknownKey: 1 })).toBe(false);
  });

  it("validates a feed index", () => {
    const validate = ajv.compile(jsonSchemas()["feed-index.schema.json"] as object);
    expect(
      validate({
        schemaVersion: 1,
        releases: [
          {
            version: "1.4.0",
            tag: "v1.4.0",
            prerelease: false,
            publishedAt: "2026-11-02T18:20:00Z",
            releaseJson: "https://downloads.example.com/notes/1.4.0/release.json",
            bundle: "https://downloads.example.com/notes/1.4.0/release.json.sigstore.json",
            notesUrl: "https://downloads.example.com/notes/1.4.0/NOTES.md",
          },
        ],
      }),
    ).toBe(true);
  });

  it("describes every endpoint of the API with an operation id", () => {
    const document = openApiDocument() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const operations = Object.values(document.paths).flatMap((methods) =>
      Object.values(methods).map((op) => op.operationId),
    );
    expect(operations.sort()).toEqual(
      [
        "acknowledgeRun",
        "cancelRun",
        "getCapabilities",
        "getConfig",
        "getHealth",
        "getOpenApi",
        "getPublicStatus",
        "getRun",
        "getState",
        "listBackups",
        "listEvents",
        "listReleases",
        "listRuns",
        "rescheduleRun",
        "scheduleRun",
        "verifyRelease",
      ].sort(),
    );
    for (const name of [
      "StateView",
      "Run",
      "Problem",
      "ScheduleRequest",
      "PublicStatus",
      "JournalEvent",
      "VerificationResult",
    ]) {
      expect(document.components.schemas, name).toHaveProperty(name);
    }
    expect(JSON.stringify(document)).not.toContain("#/$defs/");
  });

  it("matches the committed files (run pnpm generate after changing the protocol)", () => {
    for (const [name, schema] of Object.entries(jsonSchemas())) {
      const committed = readFileSync(new URL(`../../../schemas/${name}`, import.meta.url), "utf8");
      expect(committed, name).toBe(`${JSON.stringify(schema, null, 2)}\n`);
    }
  });
});
