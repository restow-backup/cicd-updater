import {
  channelOf,
  isPlainVersion,
  parseReleaseDocument,
  type ReleaseDocument,
  type ReleaseImage,
  releaseDocumentSchema,
  releaseRuleViolations,
  type TrustMode,
} from "@cicd-updater/protocol";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The release side of `release.json` (design 3, 10.6): the policy file
 * committed in the app repository, creating the document from the actually
 * pushed index digests (never typed by hand), and validating it with the
 * schema and the additional rules.
 */

export const DEFAULT_POLICY_FILE = ".cicd-updater/release-policy.yaml";

const versionText = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/);

export const releasePolicySchema = z.strictObject({
  minimumFromVersion: versionText.nullable().default(null),
  requiresUpdater: z
    .string()
    .regex(/^(>=|\^)?[0-9]+\.[0-9]+\.[0-9]+$/)
    .nullable()
    .default(">=1.0.0"),
  requiresEnv: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
    .max(64)
    .default([]),
  manualSteps: z
    .strictObject({
      required: z.boolean().default(false),
      summary: z.string().max(2000).nullable().default(null),
      url: z
        .string()
        .max(2000)
        .regex(/^https:\/\//)
        .nullable()
        .default(null),
    })
    .prefault({}),
});
export type ReleasePolicy = z.output<typeof releasePolicySchema>;

/** Parse the policy file text (YAML); an absent file means the defaults. */
export function parsePolicy(text: string | null): ReleasePolicy {
  const raw =
    text === null || text.trim() === "" ? {} : parse(text, { version: "1.2", maxAliasCount: 0 });
  const result = releasePolicySchema.safeParse(raw ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `release policy: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return result.data;
}

/** Images as the publish step reports them: key -> repository, tag, index digest, platforms. */
export const publishedImagesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.object({
    repository: z.string(),
    tag: z.string(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    platforms: z.array(z.enum(["linux/amd64", "linux/arm64"])).min(1),
  }),
);
export type PublishedImages = z.infer<typeof publishedImagesSchema>;

export interface CreateInput {
  images: PublishedImages;
  version: string;
  tag: string;
  /** `host/owner/repo`; from the CI (GITHUB_SERVER_URL + GITHUB_REPOSITORY, CI_SERVER_HOST + CI_PROJECT_PATH). */
  project: string;
  commit: string | null;
  createdAt: Date;
  notesUrl: string | null;
  policy: ReleasePolicy;
  signing: { mode: TrustMode; toolVersion: string | null };
  /** How the version maps to the tag (the sidecar's release.tagPattern); default `v{version}`. */
  tagPattern?: string;
}

/** `https://github.com/acme/notes` or `https://git.example.com/forge` + `acme/notes` -> `github.com/acme/notes`. */
export function projectOf(serverUrl: string, repository: string): string {
  const url = new URL(serverUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.host}${prefix}/${repository}`.toLowerCase().replace(/\/{2,}/g, "/");
}

/** Build and validate the document; throws with the first problem. */
export function createReleaseDocument(input: CreateInput): ReleaseDocument {
  if (!isPlainVersion(input.version)) {
    throw new Error(`${input.version} is not a plain version (no v, no build metadata).`);
  }
  const images: Record<string, ReleaseImage> = {};
  for (const [key, image] of Object.entries(input.images)) {
    images[key] = {
      repository: image.repository,
      tag: image.tag,
      digest: image.digest,
      platforms: [...image.platforms],
    };
  }
  const document: ReleaseDocument = {
    schemaVersion: 1,
    project: input.project,
    version: input.version,
    tag: input.tag,
    channel: channelOf(input.version),
    commit: input.commit,
    createdAt: input.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    notesUrl: input.notesUrl,
    images,
    upgrade: {
      minimumFromVersion: input.policy.minimumFromVersion,
      manualSteps: {
        required: input.policy.manualSteps.required,
        summary: input.policy.manualSteps.summary,
        url: input.policy.manualSteps.url,
      },
    },
    requires: {
      ...(input.policy.requiresUpdater ? { updater: input.policy.requiresUpdater } : {}),
      ...(input.policy.requiresEnv.length > 0 ? { env: [...input.policy.requiresEnv] } : {}),
    },
    signing: {
      mode: input.signing.mode,
      tool: "cosign",
      ...(input.signing.toolVersion ? { toolVersion: input.signing.toolVersion } : {}),
    },
  };
  const parsed = releaseDocumentSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `release.json: ${issue?.path.join(".") || "document"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const violation = releaseRuleViolations(parsed.data, {
    gitTag: input.tag,
    tagPattern: input.tagPattern ?? "v{version}",
  })[0];
  if (violation) {
    throw new Error(`release.json: ${violation.code}: ${violation.detail}`);
  }
  return document;
}

/** Serialize as the release asset: pretty JSON, UTF-8 without BOM, final newline. */
export function serializeReleaseDocument(document: ReleaseDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Validate bytes the way the sidecar reads them, plus the Git tag the action ran for. */
export function validateReleaseBytes(
  bytes: Uint8Array,
  options: { gitTag?: string; tagPattern?: string } = {},
) {
  return parseReleaseDocument(bytes, options);
}
