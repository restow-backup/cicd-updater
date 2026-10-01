import { createHash } from "node:crypto";
import {
  compareVersions,
  DEFAULT_TAG_PATTERN,
  RELEASE_BUNDLE_MAX_BYTES,
  RELEASE_DOCUMENT_MAX_BYTES,
} from "@cicd-updater/protocol";
import { HostPolicy } from "./address-policy.js";
import { FeedError, FeedHttp, type FetchLike } from "./http.js";
import { type FeedEntry, type FeedSource, type ResolvedFeed, resolveFeed } from "./providers.js";

export interface FeedReaderOptions {
  source: FeedSource;
  /** Token for a private repository; sent only to the feed's own origin. */
  token?: string | null;
  tagPattern?: string;
  /** Hosts (exact, lowercase) allowed to resolve to private networks. */
  allowPrivateHosts?: readonly string[];
  /** Replaces the guarded transport (tests). */
  fetch?: FetchLike;
  /** Tests only. */
  allowInsecureHttp?: boolean;
  /** Timeout of the list request (assets: 15 s). */
  timeoutMs?: number;
  now?: () => number;
}

export interface FetchedDocument {
  bytes: Buffer;
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads one feed: the release list, and the documents of single releases. */
export class FeedReader {
  readonly feed: ResolvedFeed;
  private readonly http: FeedHttp;
  private readonly tagPattern: string;

  constructor(private readonly options: FeedReaderOptions) {
    this.feed = resolveFeed(options.source);
    this.tagPattern = options.tagPattern ?? DEFAULT_TAG_PATTERN;
    this.http = new FeedHttp({
      policy: new HostPolicy(options.allowPrivateHosts ?? []),
      token: options.token ?? null,
      tokenOrigin: this.feed.origin,
      authScheme: this.feed.authScheme,
      fetch: options.fetch,
      allowInsecureHttp: options.allowInsecureHttp,
      now: options.now,
    });
  }

  /** Every release of the feed (drafts and non-version tags dropped), newest first, no duplicates. */
  async list(): Promise<FeedEntry[]> {
    const body = await this.http.getJson(this.feed.listUrl, undefined, this.options.timeoutMs);
    let parsed: FeedEntry[];
    try {
      parsed = this.feed.parse(body, this.tagPattern, Boolean(this.options.token));
    } catch {
      throw new FeedError("invalid_response", null, null, "schema");
    }
    const seen = new Set<string>();
    const unique = parsed
      .sort((a, b) => compareVersions(b.version, a.version))
      .filter((entry) => {
        if (seen.has(entry.version)) {
          return false;
        }
        seen.add(entry.version);
        return true;
      });
    if (unique.length === 0) {
      throw new FeedError("no_release");
    }
    return unique;
  }

  /** The release document of an entry (at most 64 KiB); null when the release has none. */
  async document(entry: FeedEntry): Promise<FetchedDocument | null> {
    if (!entry.releaseJson) {
      return null;
    }
    const bytes = await this.http.getAsset(
      entry.releaseJson.url,
      RELEASE_DOCUMENT_MAX_BYTES,
      entry.releaseJson.accept,
    );
    return { bytes, sha256: sha256Hex(bytes) };
  }

  /** The Sigstore bundle of the release document (at most 256 KiB); null when there is none. */
  async bundle(entry: FeedEntry): Promise<Buffer | null> {
    if (!entry.bundle) {
      return null;
    }
    return await this.http.getAsset(
      entry.bundle.url,
      RELEASE_BUNDLE_MAX_BYTES,
      entry.bundle.accept,
    );
  }
}
