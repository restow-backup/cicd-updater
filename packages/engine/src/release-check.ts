import { createHash } from "node:crypto";
import {
  channelAllows,
  compareVersions,
  isNewer,
  parseReleaseDocument,
  type RefusalCode,
  type ReleaseDocument,
  type ReleasesView,
  satisfiesRange,
  type UpdateMode,
  type UpdaterConfig,
  type VerificationResult,
} from "@cicd-updater/protocol";
import type { EnvFile } from "./env-file.js";
import { envValueOf } from "./env-file.js";
import { EngineError } from "./errors.js";
import {
  type CatalogEntry,
  CatalogError,
  type Clock,
  type DockerOps,
  type ReleaseCatalog,
  type Verifier,
  VerifyError,
} from "./ports.js";
import type { Redactor } from "./redact.js";
import type { RunningVersion, RunningVersionResolver } from "./running-version.js";

/**
 * Release documents from the feed: fetching, verifying, validating, and the
 * refusals that keep a release from being installed (design 3, 5.3 prepare 4,
 * 6.3). Used when scheduling (nothing unverifiable is ever announced), by the
 * dry-run verification endpoint, by the release list, and again at the start
 * of a run on the stored bytes.
 */

export interface PlanEntry {
  imageKey: string;
  /** `repository@digest` that is verified and pulled; null in source mode. */
  pullRef: string | null;
  /** The reference written into the env file. */
  ref: string;
  /** Optional service whose image the release lacks: it keeps its current image. */
  optionalKept: boolean;
}

export type Plan = Record<string, PlanEntry>;

/**
 * Whether the reference written into the env file names the tag as well as the
 * digest (`repo:tag@digest`, design 5.3 fetch 6). Compose and Docker resolve
 * the digest; the tag is for people reading the file. To be verified in the
 * e2e on both image stores (docs/compatibility.md); the fallback is
 * `repo@digest`.
 */
export const WRITE_TAG_WITH_DIGEST = true;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The image plan of a release in image mode, and the services whose image key is missing. */
export function buildImagePlan(
  config: Pick<UpdaterConfig, "services" | "images">,
  document: ReleaseDocument,
): { plan: Plan; missing: string[] } {
  const plan: Plan = {};
  const missing: string[] = [];
  for (const service of config.services) {
    const image = document.images[service.image];
    if (!image) {
      if (service.optional) {
        plan[service.name] = {
          imageKey: service.image,
          pullRef: null,
          ref: "",
          optionalKept: true,
        };
      } else {
        missing.push(service.name);
      }
      continue;
    }
    const repository = config.images[service.image]?.repository ?? image.repository;
    plan[service.name] = {
      imageKey: service.image,
      pullRef: `${repository}@${image.digest}`,
      ref: WRITE_TAG_WITH_DIGEST
        ? `${repository}:${image.tag}@${image.digest}`
        : `${repository}@${image.digest}`,
      optionalKept: false,
    };
  }
  return { plan, missing };
}

/** The local tag a source-mode build gets. */
export function sourceImageRef(projectName: string, imageKey: string, version: string): string {
  return `cicd-updater.local/${projectName}/${imageKey}:${version}`;
}

/** The image plan in source mode: every managed service gets the local build of its image key. */
export function buildSourcePlan(
  config: Pick<UpdaterConfig, "services">,
  projectName: string,
  version: string,
): Plan {
  const plan: Plan = {};
  for (const service of config.services) {
    plan[service.name] = {
      imageKey: service.image,
      pullRef: null,
      ref: sourceImageRef(projectName, service.image, version),
      optionalKept: false,
    };
  }
  return plan;
}

/** Whether `release.json.project` names the configured feed repository (a Forgejo path prefix may be left out). */
export function projectMatches(documentProject: string, feedProject: string): boolean {
  const doc = documentProject.toLowerCase();
  const feed = feedProject.toLowerCase();
  if (doc === feed) {
    return true;
  }
  const [docHost, ...docPath] = doc.split("/");
  const [feedHost, ...feedPath] = feed.split("/");
  return (
    docHost === feedHost &&
    docPath.length >= 2 &&
    docPath.length < feedPath.length &&
    feedPath.slice(feedPath.length - docPath.length).join("/") === docPath.join("/")
  );
}

export interface PreparedRelease {
  version: string;
  tag: string;
  entry: CatalogEntry;
  documentBytes: Uint8Array | null;
  bundle: Uint8Array | null;
  document: ReleaseDocument | null;
  sha256: string | null;
  documentStatus: "verified" | "not_checked";
}

export interface Refusals {
  reasons: RefusalCode[];
  /** Short detail per reason (key names only for env_missing). */
  details: Partial<Record<RefusalCode, string>>;
}

export interface ReleaseServiceDeps {
  config: UpdaterConfig;
  catalog: ReleaseCatalog;
  verifier: Verifier;
  ops: DockerOps;
  envFile: EnvFile;
  running: RunningVersionResolver;
  updaterVersion: string;
  clock: Clock;
  redactor: Redactor;
}

const VERIFICATION_CACHE_MS = 10 * 60_000;
const MAX_RELEASES = 10;

export class ReleaseService {
  private readonly verifications = new Map<string, { at: number; result: VerificationResult }>();

  constructor(private readonly deps: ReleaseServiceDeps) {}

  /** Validate a release document's bytes against this installation (schema, rules, version, tag, project). */
  validateDocument(bytes: Uint8Array, version: string, tag: string): ReleaseDocument {
    const parsed = parseReleaseDocument(bytes, { tagPattern: this.deps.config.release.tagPattern });
    if (!parsed.ok) {
      throw new EngineError(
        "release_unverifiable",
        `release.json is not valid (${parsed.code}: ${parsed.detail}).`,
      );
    }
    const document = parsed.document;
    if (document.version !== version || document.tag !== tag) {
      throw new EngineError(
        "release_unverifiable",
        `release.json describes ${document.version} (${document.tag}), not ${version} (${tag}) (release.mismatch).`,
      );
    }
    const project = this.deps.catalog.project;
    if (project !== null && !projectMatches(document.project, project)) {
      throw new EngineError(
        "release_unverifiable",
        `release.json belongs to ${document.project}, not to the configured feed ${project} (release.mismatch).`,
      );
    }
    return document;
  }

  /**
   * Fetch a release, verify its document in the trust mode (image mode) and
   * validate it. Throws {@link EngineError}.
   */
  async prepare(version: string, mode: UpdateMode): Promise<PreparedRelease> {
    let fetched: Awaited<ReturnType<ReleaseCatalog["fetch"]>>;
    try {
      fetched = await this.deps.catalog.fetch(version);
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new EngineError(
          error.code,
          error.message,
          error.feedError ? { feedError: error.feedError } : {},
        );
      }
      throw error;
    }
    const { entry, document: bytes, bundle } = fetched;
    if (!bytes) {
      if (mode === "image") {
        throw new EngineError(
          "release_not_found",
          `Release ${version} has no release.json; it cannot be installed by the updater (update by hand).`,
        );
      }
      return {
        version,
        tag: entry.tag,
        entry,
        documentBytes: null,
        bundle: null,
        document: null,
        sha256: null,
        documentStatus: "not_checked",
      };
    }
    let documentStatus: "verified" | "not_checked" = "not_checked";
    if (mode === "image") {
      try {
        documentStatus = await this.deps.verifier.verifyDocument({
          document: bytes,
          bundle,
          tag: entry.tag,
          version,
        });
      } catch (error) {
        if (error instanceof VerifyError) {
          throw new EngineError(
            "release_unverifiable",
            `release.json of ${version} does not verify (${error.code}): ${this.deps.redactor.oneLine(error.detail, 500)}`,
          );
        }
        throw error;
      }
    }
    const document = this.validateDocument(bytes, version, entry.tag);
    return {
      version,
      tag: entry.tag,
      entry,
      documentBytes: bytes,
      bundle,
      document,
      sha256: sha256Hex(bytes),
      documentStatus,
    };
  }

  /** Why a release cannot be installed now (design 6.1 `release_refused`). */
  async refusals(
    version: string,
    document: ReleaseDocument | null,
    mode: UpdateMode,
    running: RunningVersion,
  ): Promise<Refusals> {
    const reasons: RefusalCode[] = [];
    const details: Partial<Record<RefusalCode, string>> = {};
    const add = (reason: RefusalCode, detail: string): void => {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
        details[reason] = detail;
      }
    };
    if (running.version === null) {
      add("running_version_unknown", "the running version cannot be determined");
    } else if (isNewer(running.version, version) !== true) {
      add("not_newer", `running ${running.version}, target ${version}`);
    }
    if (document) {
      const minimum = document.upgrade.minimumFromVersion;
      if (
        minimum !== null &&
        running.version !== null &&
        compareVersions(running.version, minimum) < 0
      ) {
        add("below_minimum_version", `running ${running.version}, minimum ${minimum}`);
      }
      if (document.upgrade.manualSteps.required) {
        add("manual_steps_required", document.upgrade.manualSteps.url ?? "manual steps required");
      }
      const range = document.requires?.updater;
      if (range && !satisfiesRange(this.deps.updaterVersion, range)) {
        add("updater_too_old", `updater ${this.deps.updaterVersion}, required ${range}`);
      }
      const required = document.requires?.env ?? [];
      if (required.length > 0) {
        let text = "";
        try {
          text = await this.deps.envFile.read();
        } catch {
          text = "";
        }
        const missing = required.filter((key) => {
          const value = envValueOf(text, key);
          return value === null || value === "";
        });
        if (missing.length > 0) {
          add("env_missing", missing.join(", "));
        }
      }
      if (mode === "image") {
        const { plan, missing } = buildImagePlan(this.deps.config, document);
        if (missing.length > 0) {
          add("image_missing", `no image for ${missing.join(", ")}`);
        }
        const platform = await this.deps.ops.hostPlatform().catch(() => null);
        if (platform) {
          const keys = new Set(
            Object.values(plan)
              .filter((entry) => !entry.optionalKept)
              .map((entry) => entry.imageKey),
          );
          const lacking = [...keys].filter(
            (key) => !document.images[key]?.platforms.includes(platform),
          );
          if (lacking.length > 0) {
            add("platform_unsupported", `${platform} missing for ${lacking.join(", ")}`);
          }
        }
      }
    }
    return { reasons, details };
  }

  /** Signature and existence of every distinct image of a release (dry run, no pull). */
  async verifyImages(prepared: PreparedRelease): Promise<VerificationResult["images"]> {
    if (!prepared.document) {
      return [];
    }
    const { plan } = buildImagePlan(this.deps.config, prepared.document);
    const seen = new Set<string>();
    const results: VerificationResult["images"] = [];
    for (const entry of Object.values(plan)) {
      if (!entry.pullRef || seen.has(entry.pullRef)) {
        continue;
      }
      seen.add(entry.pullRef);
      let signature: "verified" | "failed" | "not_checked" = "not_checked";
      let exists: boolean | null = null;
      let error: string | null = null;
      try {
        signature = await this.deps.verifier.verifyImage({
          ref: entry.pullRef,
          tag: prepared.tag,
          version: prepared.version,
        });
        if (signature === "verified") {
          exists = true;
        }
      } catch (caught) {
        if (!(caught instanceof VerifyError)) {
          throw caught;
        }
        signature = "failed";
        error = `fetch.${caught.code}`;
        exists = caught.code === "image_not_found" ? false : null;
      }
      if (signature === "not_checked") {
        const check = await this.deps.verifier.imageExists(entry.pullRef);
        exists = check.exists;
        error = check.error ? `fetch.${check.error}` : null;
      }
      results.push({ key: entry.imageKey, ref: entry.pullRef, signature, exists, error });
    }
    return results;
  }

  /** The dry-run verification (POST /v1/releases/{version}/verification), cached for 10 minutes. */
  async verification(
    version: string,
    mode: UpdateMode,
    options: { useCache: boolean } = { useCache: true },
  ): Promise<{ result: VerificationResult; prepared: PreparedRelease | null }> {
    const key = `${mode}:${version}`;
    const now = this.deps.clock.now().getTime();
    const cached = this.verifications.get(key);
    if (options.useCache && cached && now - cached.at < VERIFICATION_CACHE_MS) {
      return { result: cached.result, prepared: null };
    }
    const prepared = await this.prepare(version, mode);
    const running = await this.deps.running.detect(true);
    const refusals = await this.refusals(version, prepared.document, mode, running);
    const images = mode === "image" ? await this.verifyImages(prepared) : [];
    const document = prepared.document;
    const result: VerificationResult = {
      version,
      release: {
        sha256: prepared.sha256,
        document: prepared.documentStatus,
        channel: document?.channel ?? (version.includes("-") ? "beta" : "stable"),
        notesUrl: document?.notesUrl ?? prepared.entry.notesUrl,
        manualSteps: {
          required: document?.upgrade.manualSteps.required ?? false,
          summary: document?.upgrade.manualSteps.summary ?? null,
          url: document?.upgrade.manualSteps.url ?? null,
        },
        minimumFromVersion: document?.upgrade.minimumFromVersion ?? null,
      },
      refusals: refusals.reasons,
      images,
      checkedAt: new Date(now).toISOString(),
    };
    this.verifications.set(key, { at: now, result });
    return { result, prepared };
  }

  /** Newer releases of the configured feed with their refusals (unverified metadata). */
  async releasesView(refresh: boolean): Promise<ReleasesView> {
    const { config, catalog } = this.deps;
    let entries: CatalogEntry[];
    try {
      entries = await catalog.list(refresh);
    } catch (error) {
      if (error instanceof CatalogError) {
        throw new EngineError(
          error.code,
          error.message,
          error.feedError ? { feedError: error.feedError } : {},
        );
      }
      throw error;
    }
    const channel = config.release.channel;
    const running = await this.deps.running.detect(refresh);
    const releases: ReleasesView["releases"] = [];
    for (const entry of entries
      .filter((item) => channel === "beta" || !item.prerelease)
      .slice(0, MAX_RELEASES)) {
      const base = {
        version: entry.version,
        tag: entry.tag,
        channel: (entry.prerelease ? "beta" : "stable") as "stable" | "beta",
        publishedAt: entry.publishedAt,
        notesUrl: entry.notesUrl,
        releaseSha256: null as string | null,
        minimumFromVersion: null as string | null,
        manualStepsRequired: false,
        refusals: [] as string[],
        verified: false as const,
      };
      if (running.version !== null && isNewer(running.version, entry.version) !== true) {
        releases.push({ ...base, refusals: ["not_newer"] });
        continue;
      }
      let document: ReleaseDocument | null = null;
      let sha256: string | null = null;
      if (entry.hasDocument) {
        try {
          const fetched = await catalog.fetch(entry.version);
          if (fetched.document) {
            document = this.validateDocument(fetched.document, entry.version, entry.tag);
            sha256 = sha256Hex(fetched.document);
          }
        } catch (error) {
          if (error instanceof CatalogError && error.code === "feed_unavailable") {
            throw new EngineError(
              "feed_unavailable",
              error.message,
              error.feedError ? { feedError: error.feedError } : {},
            );
          }
          document = null;
        }
      }
      if (document && !channelAllows(channel, document.version)) {
        continue;
      }
      const refusals = document
        ? (await this.refusals(entry.version, document, "image", running)).reasons
        : ["no_release_document" as const];
      releases.push({
        ...base,
        channel: document?.channel ?? base.channel,
        notesUrl: document?.notesUrl ?? entry.notesUrl,
        releaseSha256: sha256,
        minimumFromVersion: document?.upgrade.minimumFromVersion ?? null,
        manualStepsRequired: document?.upgrade.manualSteps.required ?? false,
        refusals,
      });
    }
    return {
      channel,
      running: running.version,
      releases,
      nextInstallable: releases.find((release) => release.refusals.length === 0)?.version ?? null,
      checkedAt: this.deps.clock.now().toISOString(),
    };
  }
}
