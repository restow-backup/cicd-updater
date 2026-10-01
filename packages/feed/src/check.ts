import {
  channelAllows,
  compareVersions,
  isNewer,
  parseReleaseDocument,
  parseVersion,
  type ReleaseDocument,
} from "@cicd-updater/protocol";
import { FeedError, type FetchLike } from "./http.js";
import type { RemoteFeedType } from "./providers.js";
import { FeedReader } from "./reader.js";

/**
 * The SDK's feed check (design 7.3): which releases exist, which one is next,
 * what refuses each. Documents are parsed but NOT signature-verified; the
 * sidecar verifies before it installs anything.
 */

export interface FeedCheckOptions {
  feed: { type: RemoteFeedType; url: string };
  /** Sent only to the feed's own origin, as a header. */
  token?: string | null;
  channel: "stable" | "beta";
  /** The app's own version (null when unknown). */
  running: string | null;
  tagPattern?: string;
  /** Hosts (exact, lowercase) the operator allows on private/loopback networks. */
  allowPrivateHosts?: string[];
  /** How many of the newest releases get their release.json read (default 10, max 10). */
  resolveDocuments?: number;
  /** Timeout of the list request (default 10000; assets 15000). */
  timeoutMs?: number;
  now?: () => Date;
  /** Replaces the guarded transport. For tests only. */
  fetch?: FetchLike;
  /** For tests only. */
  allowInsecureHttp?: boolean;
}

export type FeedRefusal =
  | "no_release_document"
  | "below_minimum_version"
  | "manual_steps_required"
  | "not_newer";

export interface FeedRelease {
  version: string;
  tag: string;
  channel: "stable" | "beta";
  publishedAt: string | null;
  notesUrl: string | null;
  /** Parsed release.json, NOT signature-verified (the sidecar verifies). */
  document: ReleaseDocument | null;
  /** Pass as `expect.releaseSha256` when scheduling. */
  documentSha256: string | null;
  refusals: FeedRefusal[];
}

export type FeedCheckResult =
  | {
      ok: true;
      checkedAt: string;
      releases: FeedRelease[];
      latest: FeedRelease | null;
      updateAvailable: boolean | null;
      nextInstallable: FeedRelease | null;
    }
  | { ok: false; checkedAt: string; error: FeedError };

export const MAX_FEED_RELEASES = 10;

export async function checkFeed(options: FeedCheckOptions): Promise<FeedCheckResult> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  let reader: FeedReader;
  try {
    reader = new FeedReader({
      source: options.feed,
      token: options.token ?? null,
      tagPattern: options.tagPattern,
      allowPrivateHosts: options.allowPrivateHosts,
      fetch: options.fetch,
      allowInsecureHttp: options.allowInsecureHttp,
      timeoutMs: options.timeoutMs,
      now: options.now ? () => (options.now as () => Date)().getTime() : undefined,
    });
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      error: new FeedError("invalid_response", null, null, (error as Error).message),
    };
  }
  const running = options.running && parseVersion(options.running) ? options.running : null;
  const budget = Math.max(
    0,
    Math.min(MAX_FEED_RELEASES, options.resolveDocuments ?? MAX_FEED_RELEASES),
  );
  try {
    const entries = (await reader.list())
      .filter((entry) => options.channel === "beta" || !entry.prerelease)
      .slice(0, MAX_FEED_RELEASES);
    const releases: FeedRelease[] = [];
    let resolved = 0;
    for (const entry of entries) {
      const newer = running === null ? true : isNewer(running, entry.version) === true;
      const release: FeedRelease = {
        version: entry.version,
        tag: entry.tag,
        channel: entry.prerelease ? "beta" : "stable",
        publishedAt: entry.publishedAt,
        notesUrl: entry.notesUrl,
        document: null,
        documentSha256: null,
        refusals: [],
      };
      if (!newer) {
        release.refusals.push("not_newer");
        releases.push(release);
        continue;
      }
      if (resolved >= budget) {
        releases.push(release);
        continue;
      }
      resolved += 1;
      const fetched = await reader.document(entry);
      const parsed = fetched
        ? parseReleaseDocument(fetched.bytes, { tagPattern: options.tagPattern })
        : null;
      if (
        !fetched ||
        !parsed?.ok ||
        parsed.document.version !== entry.version ||
        parsed.document.tag !== entry.tag
      ) {
        release.refusals.push("no_release_document");
        releases.push(release);
        continue;
      }
      const document = parsed.document;
      // The signed document decides the channel; the provider flag only pre-filtered.
      if (!channelAllows(options.channel, document.version)) {
        continue;
      }
      release.channel = document.channel;
      release.document = document;
      release.documentSha256 = fetched.sha256;
      release.notesUrl = document.notesUrl ?? release.notesUrl;
      const minimum = document.upgrade.minimumFromVersion;
      if (running !== null && minimum !== null && compareVersions(running, minimum) < 0) {
        release.refusals.push("below_minimum_version");
      }
      if (document.upgrade.manualSteps.required) {
        release.refusals.push("manual_steps_required");
      }
      releases.push(release);
    }
    return {
      ok: true,
      checkedAt,
      releases,
      latest: releases[0] ?? null,
      updateAvailable:
        running === null
          ? null
          : releases.some((release) => !release.refusals.includes("not_newer")),
      nextInstallable:
        releases.find((release) => release.document !== null && release.refusals.length === 0) ??
        null,
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      error: error instanceof FeedError ? error : new FeedError("network"),
    };
  }
}
