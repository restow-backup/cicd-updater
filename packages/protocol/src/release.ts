import { z } from "zod";
import { CHANNELS, PLATFORMS, type ReleaseDocumentError, TRUST_MODES } from "./codes.js";
import { isValidTagPattern, renderTag } from "./identity.js";
import { compareVersions, isPrerelease, PLAIN_VERSION_PATTERN, RANGE_PATTERN } from "./semver.js";

/**
 * `release.json`, the contract between the release side and the sidecar
 * (design 3). The normative JSON Schema is `schemas/release.schema.json`; this
 * zod schema mirrors it (test/release-schema.test.ts checks that both accept and
 * refuse the same documents). Unknown fields are ignored (forward compatible
 * within schema version 1).
 */

export const RELEASE_SCHEMA_VERSION = 1;
export const RELEASE_DOCUMENT_NAME = "release.json";
export const RELEASE_BUNDLE_NAME = "release.json.sigstore.json";
export const RELEASE_DOCUMENT_MAX_BYTES = 64 * 1024;
export const RELEASE_BUNDLE_MAX_BYTES = 256 * 1024;

const versionText = z.string().max(64).regex(PLAIN_VERSION_PATTERN);

export const PROJECT_PATTERN =
  /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(\/[A-Za-z0-9_.-]{1,100}){2,6}$/;
export const RELEASE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const IMAGE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const IMAGE_REPOSITORY_PATTERN =
  /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
export const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

export const releaseImageSchema = z.object({
  repository: z.string().max(255).regex(IMAGE_REPOSITORY_PATTERN),
  tag: z.string().regex(IMAGE_TAG_PATTERN),
  digest: z.string().regex(DIGEST_PATTERN),
  platforms: z
    .array(z.enum(PLATFORMS))
    .min(1)
    .refine(unique, { message: "platforms must be unique" }),
});
export type ReleaseImage = z.infer<typeof releaseImageSchema>;

export const releaseDocumentSchema = z.object({
  schemaVersion: z.literal(RELEASE_SCHEMA_VERSION),
  project: z.string().max(300).regex(PROJECT_PATTERN),
  version: versionText,
  tag: z.string().max(128).regex(RELEASE_TAG_PATTERN),
  channel: z.enum(CHANNELS),
  commit: z
    .string()
    .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/)
    .nullable()
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
  notesUrl: z
    .string()
    .max(2000)
    .regex(/^https:\/\//)
    .nullable()
    .optional(),
  images: z
    .record(z.string().regex(IMAGE_KEY_PATTERN), releaseImageSchema)
    .refine((images) => Object.keys(images).length >= 1, { message: "at least one image" })
    .refine((images) => Object.keys(images).length <= 32, { message: "at most 32 images" }),
  upgrade: z.object({
    minimumFromVersion: versionText.nullable(),
    manualSteps: z.object({
      required: z.boolean(),
      summary: z.string().max(2000).nullable().optional(),
      url: z
        .string()
        .max(2000)
        .regex(/^https:\/\//)
        .nullable()
        .optional(),
    }),
  }),
  requires: z
    .object({
      updater: z.string().max(64).regex(RANGE_PATTERN).optional(),
      env: z
        .array(z.string().regex(ENV_KEY_PATTERN))
        .max(64)
        .refine(unique, { message: "env keys must be unique" })
        .optional(),
    })
    .optional(),
  signing: z.object({
    mode: z.enum(TRUST_MODES),
    tool: z.literal("cosign").optional(),
    toolVersion: z.string().max(32).optional(),
  }),
});
export type ReleaseDocument = z.infer<typeof releaseDocumentSchema>;

export interface ReleaseRuleOptions {
  /** `release.tagPattern` of the reader: `tag` must render from it (sidecar side). */
  tagPattern?: string;
  /** The Git tag the release side ran for (action side). */
  gitTag?: string;
}

export interface ReleaseRuleViolation {
  code: ReleaseDocumentError;
  detail: string;
}

/** The rules the JSON Schema cannot express (design 3.2). */
export function releaseRuleViolations(
  document: ReleaseDocument,
  options: ReleaseRuleOptions = {},
): ReleaseRuleViolation[] {
  const problems: ReleaseRuleViolation[] = [];
  const beta = isPrerelease(document.version);
  if ((document.channel === "beta") !== beta) {
    problems.push({
      code: "release.channel_mismatch",
      detail: `channel is ${document.channel} but version ${document.version} ${beta ? "is" : "is not"} a pre-release`,
    });
  }
  if (options.tagPattern !== undefined) {
    if (!isValidTagPattern(options.tagPattern)) {
      problems.push({ code: "release.tag_mismatch", detail: "the tag pattern is not valid" });
    } else if (renderTag(options.tagPattern, document.version) !== document.tag) {
      problems.push({
        code: "release.tag_mismatch",
        detail: `tag ${document.tag} does not render from ${options.tagPattern} with version ${document.version}`,
      });
    }
  }
  if (options.gitTag !== undefined && options.gitTag !== document.tag) {
    problems.push({
      code: "release.tag_mismatch",
      detail: `tag ${document.tag} differs from the Git tag ${options.gitTag}`,
    });
  }
  for (const [key, image] of Object.entries(document.images)) {
    if (image.tag !== document.version) {
      problems.push({
        code: "release.image_tag_mismatch",
        detail: `images.${key}.tag is ${image.tag}, expected ${document.version}`,
      });
    }
  }
  const minimum = document.upgrade.minimumFromVersion;
  if (minimum !== null && compareVersions(minimum, document.version) >= 0) {
    problems.push({
      code: "release.minimum_not_lower",
      detail: `minimumFromVersion ${minimum} is not lower than ${document.version}`,
    });
  }
  return problems;
}

export type ParsedRelease =
  | { ok: true; document: ReleaseDocument }
  | { ok: false; code: ReleaseDocumentError; detail: string };

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Read a release document from its bytes, as the sidecar and the SDK do: at most
 * 64 KiB, UTF-8 without BOM, JSON, schema version 1, the schema and the
 * additional rules. Readers MUST reject schema versions they do not know.
 */
export function parseReleaseDocument(
  bytes: Uint8Array | string,
  options: ReleaseRuleOptions = {},
): ParsedRelease {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  if (data.byteLength > RELEASE_DOCUMENT_MAX_BYTES) {
    return { ok: false, code: "release.too_large", detail: `${data.byteLength} bytes` };
  }
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return { ok: false, code: "release.bom", detail: "the document starts with a byte order mark" };
  }
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return { ok: false, code: "release.not_json", detail: "the document is not UTF-8" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "release.not_json", detail: "the document is not JSON" };
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, code: "release.schema", detail: "the document is not an object" };
  }
  const schemaVersion = (json as { schemaVersion?: unknown }).schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion !== RELEASE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "release.unsupported_schema",
      detail: `schemaVersion ${schemaVersion} is not supported (this reader knows 1)`,
    };
  }
  const parsed = releaseDocumentSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "document";
    return {
      ok: false,
      code: "release.schema",
      detail: `${where}: ${issue?.message ?? "invalid"}`,
    };
  }
  const violation = releaseRuleViolations(parsed.data, options)[0];
  if (violation) {
    return { ok: false, code: violation.code, detail: violation.detail };
  }
  return { ok: true, document: parsed.data };
}

/** `host/owner/repo` of a feed repository URL, lowercased, for the `project` comparison. */
export function projectOfRepositoryUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }
    const last = (segments.at(-1) as string).replace(/\.git$/i, "");
    return [parsed.host.toLowerCase(), ...segments.slice(0, -1), last].join("/").toLowerCase();
  } catch {
    return null;
  }
}
