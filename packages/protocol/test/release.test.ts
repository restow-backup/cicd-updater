import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  parseReleaseDocument,
  projectOfRepositoryUrl,
  type ReleaseDocument,
  releaseDocumentSchema,
  releaseJsonSchema,
  releaseRuleViolations,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/release.json", import.meta.url), "utf8"),
) as ReleaseDocument;

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (ajv: Ajv2020) => void)(ajv);
const validateJsonSchema = ajv.compile(releaseJsonSchema);

function variant(change: (doc: Record<string, unknown>) => void): Record<string, unknown> {
  const doc = structuredClone(fixture) as unknown as Record<string, unknown>;
  change(doc);
  return doc;
}

const images = (doc: Record<string, unknown>) =>
  doc.images as Record<string, Record<string, unknown>>;

/** Documents both schemas must refuse. */
const INVALID: [string, Record<string, unknown>][] = [
  [
    "schemaVersion 2",
    variant((d) => {
      d.schemaVersion = 2;
    }),
  ],
  [
    "missing project",
    variant((d) => {
      delete d.project;
    }),
  ],
  [
    "project without repository",
    variant((d) => {
      d.project = "github.com/acme";
    }),
  ],
  [
    "uppercase host",
    variant((d) => {
      d.project = "GitHub.com/acme/notes";
    }),
  ],
  [
    "version with v",
    variant((d) => {
      d.version = "v1.4.0";
    }),
  ],
  [
    "version with build metadata",
    variant((d) => {
      d.version = "1.4.0+build";
    }),
  ],
  [
    "leading zero",
    variant((d) => {
      d.version = "01.4.0";
    }),
  ],
  [
    "channel nightly",
    variant((d) => {
      d.channel = "nightly";
    }),
  ],
  [
    "commit uppercase",
    variant((d) => {
      d.commit = "4F1C0B6E2A9D8C7B6A5F4E3D2C1B0A9F8E7D6C5B";
    }),
  ],
  [
    "commit short",
    variant((d) => {
      d.commit = "4f1c0b6";
    }),
  ],
  [
    "createdAt not a time",
    variant((d) => {
      d.createdAt = "yesterday";
    }),
  ],
  [
    "notesUrl http",
    variant((d) => {
      d.notesUrl = "http://example.com";
    }),
  ],
  [
    "no images",
    variant((d) => {
      d.images = {};
    }),
  ],
  [
    "image key uppercase",
    variant((d) => {
      d.images = { App: images(d).app };
    }),
  ],
  [
    "digest sha512",
    variant((d) => {
      (images(d).app as Record<string, unknown>).digest = `sha512:${"a".repeat(64)}`;
    }),
  ],
  [
    "digest short",
    variant((d) => {
      (images(d).app as Record<string, unknown>).digest = "sha256:abc";
    }),
  ],
  [
    "repository with tag",
    variant((d) => {
      (images(d).app as Record<string, unknown>).repository = "ghcr.io/acme/notes:1.4.0";
    }),
  ],
  [
    "repository uppercase",
    variant((d) => {
      (images(d).app as Record<string, unknown>).repository = "ghcr.io/Acme/notes";
    }),
  ],
  [
    "platform arm/v7",
    variant((d) => {
      (images(d).app as Record<string, unknown>).platforms = ["linux/arm/v7"];
    }),
  ],
  [
    "platforms empty",
    variant((d) => {
      (images(d).app as Record<string, unknown>).platforms = [];
    }),
  ],
  [
    "platforms duplicate",
    variant((d) => {
      (images(d).app as Record<string, unknown>).platforms = ["linux/amd64", "linux/amd64"];
    }),
  ],
  [
    "missing upgrade",
    variant((d) => {
      delete d.upgrade;
    }),
  ],
  [
    "manual steps without required",
    variant((d) => {
      d.upgrade = { minimumFromVersion: null, manualSteps: {} };
    }),
  ],
  [
    "requires.updater with tilde",
    variant((d) => {
      d.requires = { updater: "~1.0.0" };
    }),
  ],
  [
    "requires.env duplicate",
    variant((d) => {
      d.requires = { env: ["A", "A"] };
    }),
  ],
  [
    "requires.env bad name",
    variant((d) => {
      d.requires = { env: ["1A"] };
    }),
  ],
  [
    "signing mode unknown",
    variant((d) => {
      d.signing = { mode: "gpg" };
    }),
  ],
  [
    "signing tool other",
    variant((d) => {
      d.signing = { mode: "key", tool: "notation" };
    }),
  ],
];

/** Documents both schemas must accept. */
const VALID: [string, Record<string, unknown>][] = [
  ["the design example", variant(() => undefined)],
  [
    "unknown fields are ignored",
    variant((d) => {
      d.futureField = { a: 1 };
      (images(d).app as Record<string, unknown>).sbom = "x";
    }),
  ],
  [
    "no commit, no notes, no requires",
    variant((d) => {
      delete d.commit;
      delete d.notesUrl;
      delete d.requires;
    }),
  ],
  [
    "null commit and notes",
    variant((d) => {
      d.commit = null;
      d.notesUrl = null;
    }),
  ],
  [
    "sha256 commit",
    variant((d) => {
      d.commit = "a".repeat(64);
    }),
  ],
  [
    "gitlab subgroup project with port",
    variant((d) => {
      d.project = "gitlab.example.com:8443/group/sub/project";
    }),
  ],
  [
    "registry with port",
    variant((d) => {
      (images(d).app as Record<string, unknown>).repository =
        "registry.example.com:5000/acme/notes";
    }),
  ],
  [
    "single platform",
    variant((d) => {
      (images(d).app as Record<string, unknown>).platforms = ["linux/arm64"];
    }),
  ],
  [
    "caret range",
    variant((d) => {
      d.requires = { updater: "^1.2.0" };
    }),
  ],
  [
    "minimal signing",
    variant((d) => {
      d.signing = { mode: "none" };
    }),
  ],
  [
    "pre-release on beta",
    variant((d) => {
      d.version = "1.5.0-rc.1";
      d.channel = "beta";
      d.tag = "v1.5.0-rc.1";
    }),
  ],
];

describe("release.json schema", () => {
  it.each(VALID)("both schemas accept: %s", (_name, doc) => {
    expect(validateJsonSchema(doc), JSON.stringify(validateJsonSchema.errors)).toBe(true);
    expect(releaseDocumentSchema.safeParse(doc).success).toBe(true);
  });

  it.each(INVALID)("both schemas refuse: %s", (_name, doc) => {
    expect(validateJsonSchema(doc)).toBe(false);
    expect(releaseDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("the committed schema file is the normative schema", () => {
    const committed = JSON.parse(
      readFileSync(new URL("../../../schemas/release.schema.json", import.meta.url), "utf8"),
    );
    expect(committed).toEqual(releaseJsonSchema);
  });
});

describe("additional rules", () => {
  it("accepts the design example", () => {
    expect(releaseRuleViolations(fixture, { tagPattern: "v{version}", gitTag: "v1.4.0" })).toEqual(
      [],
    );
  });

  it("binds the channel to the pre-release part", () => {
    const beta = { ...fixture, channel: "beta" as const };
    expect(releaseRuleViolations(beta).map((v) => v.code)).toEqual(["release.channel_mismatch"]);
    const pre = { ...fixture, version: "1.4.0-rc.1", tag: "v1.4.0-rc.1" };
    expect(releaseRuleViolations(pre).map((v) => v.code)).toContain("release.channel_mismatch");
  });

  it("checks the tag against the pattern and the Git tag", () => {
    expect(releaseRuleViolations(fixture, { tagPattern: "release-{version}" })[0]?.code).toBe(
      "release.tag_mismatch",
    );
    expect(releaseRuleViolations(fixture, { gitTag: "v1.4.1" })[0]?.code).toBe(
      "release.tag_mismatch",
    );
    const prefixed = { ...fixture, tag: "notes/v1.4.0" };
    expect(releaseRuleViolations(prefixed, { tagPattern: "notes/v{version}" })).toEqual([]);
  });

  it("requires image tags to equal the version", () => {
    const doc = structuredClone(fixture);
    (doc.images.web as { tag: string }).tag = "latest";
    expect(releaseRuleViolations(doc)).toEqual([
      { code: "release.image_tag_mismatch", detail: "images.web.tag is latest, expected 1.4.0" },
    ]);
  });

  it("requires minimumFromVersion to be strictly lower", () => {
    for (const minimum of ["1.4.0", "1.5.0"]) {
      const doc = structuredClone(fixture);
      doc.upgrade.minimumFromVersion = minimum;
      expect(releaseRuleViolations(doc)[0]?.code).toBe("release.minimum_not_lower");
    }
    const doc = structuredClone(fixture);
    doc.upgrade.minimumFromVersion = "1.4.0-rc.1";
    expect(releaseRuleViolations(doc)).toEqual([]);
  });
});

describe("parseReleaseDocument", () => {
  const bytes = readFileSync(new URL("./fixtures/release.json", import.meta.url));

  it("reads the example from bytes and from text", () => {
    const parsed = parseReleaseDocument(bytes, { tagPattern: "v{version}" });
    expect(parsed.ok).toBe(true);
    expect(parseReleaseDocument(bytes.toString("utf8")).ok).toBe(true);
  });

  it("refuses a BOM, a document over 64 KiB, invalid UTF-8 and non-JSON", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
    expect(parseReleaseDocument(bom)).toMatchObject({ ok: false, code: "release.bom" });
    const big = Buffer.from(JSON.stringify({ ...fixture, padding: "x".repeat(70_000) }));
    expect(parseReleaseDocument(big)).toMatchObject({ ok: false, code: "release.too_large" });
    expect(parseReleaseDocument(Buffer.from([0x7b, 0xff, 0x7d]))).toMatchObject({
      ok: false,
      code: "release.not_json",
    });
    expect(parseReleaseDocument("{not json")).toMatchObject({
      ok: false,
      code: "release.not_json",
    });
    expect(parseReleaseDocument("[]")).toMatchObject({ ok: false, code: "release.schema" });
  });

  it("rejects schema versions it does not know", () => {
    const doc = JSON.stringify({ ...fixture, schemaVersion: 2 });
    expect(parseReleaseDocument(doc)).toMatchObject({
      ok: false,
      code: "release.unsupported_schema",
    });
  });

  it("names the first schema problem and applies the additional rules", () => {
    const doc = JSON.stringify({ ...fixture, version: "1.4" });
    expect(parseReleaseDocument(doc)).toMatchObject({ ok: false, code: "release.schema" });
    const wrongTag = JSON.stringify({ ...fixture, tag: "1.4.0" });
    expect(parseReleaseDocument(wrongTag, { tagPattern: "v{version}" })).toMatchObject({
      ok: false,
      code: "release.tag_mismatch",
    });
  });
});

describe("projectOfRepositoryUrl", () => {
  it("derives host/owner/repo", () => {
    expect(projectOfRepositoryUrl("https://github.com/Acme/Notes")).toBe("github.com/acme/notes");
    expect(projectOfRepositoryUrl("https://git.example.com/forge/acme/notes.git")).toBe(
      "git.example.com/forge/acme/notes",
    );
    expect(projectOfRepositoryUrl("https://gitlab.example.com/group/sub/project")).toBe(
      "gitlab.example.com/group/sub/project",
    );
    expect(projectOfRepositoryUrl("not a url")).toBeNull();
  });
});
