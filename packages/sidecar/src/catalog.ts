import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type CatalogEntry,
  CatalogError,
  type FetchedRelease,
  type Logger,
  type Redactor,
  type ReleaseCatalog,
  writeAtomic,
} from "@cicd-updater/engine";
import {
  type FeedEntry,
  FeedError,
  FeedReader,
  type FetchLike,
  type RemoteFeedType,
} from "@cicd-updater/feed";
import {
  compareVersions,
  FEED_INDEX_MAX_BYTES,
  feedIndexSchema,
  isPlainFileName,
  isPlainVersion,
  isPrerelease,
  RELEASE_BUNDLE_MAX_BYTES,
  RELEASE_DOCUMENT_MAX_BYTES,
  type UpdaterConfig,
  versionFromTag,
} from "@cicd-updater/protocol";

/**
 * The configured feed (design 3.3) and the store of verified release documents
 * (`<stateDir>/releases/<version>/`). Remote feeds go through the SSRF-guarded
 * feed client; the `file` feed reads a mounted directory (air-gapped hosts and
 * the release smoke test).
 */

export interface SidecarCatalogOptions {
  config: UpdaterConfig;
  stateDir: string;
  redactor: Redactor;
  logger: Logger;
  now: () => Date;
  /** Tests only: replaces the guarded transport. */
  fetch?: FetchLike;
  /** Tests only. */
  allowInsecureHttp?: boolean;
}

/** Read a secret file (trimmed) and register it for redaction; null when not configured. */
export async function readTokenFile(
  file: string | null,
  redactor: Redactor,
): Promise<string | null> {
  if (!file) {
    return null;
  }
  const value = (await fs.readFile(file, "utf8")).trim();
  if (!value) {
    return null;
  }
  redactor.add(value);
  return value;
}

interface Listing {
  at: number;
  entries: FeedEntry[];
}

export class SidecarCatalog implements ReleaseCatalog {
  readonly project: string | null;
  private listing: Listing | null = null;
  private readonly documents = new Map<
    string,
    { at: number; document: Uint8Array | null; bundle: Uint8Array | null }
  >();
  private readonly releasesDir: string;

  constructor(private readonly options: SidecarCatalogOptions) {
    this.releasesDir = path.join(options.stateDir, "releases");
    const feed = options.config.release.feed;
    if (feed.type === "file") {
      this.project = null;
    } else {
      this.project = this.reader(null).feed.project;
    }
  }

  private reader(token: string | null): FeedReader {
    const feed = this.options.config.release.feed;
    const url = new URL(feed.url as string);
    return new FeedReader({
      source: { type: feed.type as RemoteFeedType, url: feed.url as string },
      token,
      tagPattern: this.options.config.release.tagPattern,
      allowPrivateHosts: feed.allowPrivateNetwork ? [url.hostname] : [],
      fetch: this.options.fetch,
      allowInsecureHttp: this.options.allowInsecureHttp,
      now: () => this.options.now().getTime(),
    });
  }

  private async token(): Promise<string | null> {
    return await readTokenFile(this.options.config.release.feed.tokenFile, this.options.redactor);
  }

  private fresh(at: number): boolean {
    return this.options.now().getTime() - at < this.options.config.release.cacheSeconds * 1000;
  }

  private toCatalog(entry: FeedEntry): CatalogEntry {
    return {
      version: entry.version,
      tag: entry.tag,
      prerelease: entry.prerelease,
      publishedAt: entry.publishedAt,
      notesUrl: entry.notesUrl,
      hasDocument: entry.releaseJson !== null,
    };
  }

  private async entries(refresh: boolean): Promise<FeedEntry[]> {
    if (!refresh && this.listing && this.fresh(this.listing.at)) {
      return this.listing.entries;
    }
    let entries: FeedEntry[];
    try {
      entries =
        this.options.config.release.feed.type === "file"
          ? await this.listFile()
          : await this.reader(await this.token()).list();
    } catch (error) {
      throw this.catalogError(error);
    }
    this.listing = { at: this.options.now().getTime(), entries };
    if (refresh) {
      this.documents.clear();
    }
    return entries;
  }

  private catalogError(error: unknown): CatalogError {
    if (error instanceof CatalogError) {
      return error;
    }
    if (error instanceof FeedError) {
      return new CatalogError(
        "feed_unavailable",
        error.code,
        `The release feed is not available (${error.code}).`,
      );
    }
    return new CatalogError(
      "feed_unavailable",
      "network",
      `The release feed is not available: ${this.options.redactor.oneLine((error as Error).message, 300)}`,
    );
  }

  async list(refresh: boolean): Promise<CatalogEntry[]> {
    return (await this.entries(refresh)).map((entry) => this.toCatalog(entry));
  }

  async fetch(version: string): Promise<FetchedRelease> {
    const entries = await this.entries(false);
    const entry = entries.find((candidate) => candidate.version === version);
    if (!entry) {
      throw new CatalogError("release_not_found", null, `Version ${version} is not in the feed.`);
    }
    const cached = this.documents.get(version);
    if (cached && this.fresh(cached.at)) {
      return { entry: this.toCatalog(entry), document: cached.document, bundle: cached.bundle };
    }
    let document: Uint8Array | null = null;
    let bundle: Uint8Array | null = null;
    try {
      if (this.options.config.release.feed.type === "file") {
        document = entry.releaseJson
          ? await this.readFeedFile(entry.releaseJson.url, RELEASE_DOCUMENT_MAX_BYTES)
          : null;
        bundle = entry.bundle
          ? await this.readFeedFile(entry.bundle.url, RELEASE_BUNDLE_MAX_BYTES)
          : null;
      } else {
        const reader = this.reader(await this.token());
        document = (await reader.document(entry))?.bytes ?? null;
        bundle = document ? await reader.bundle(entry) : null;
      }
    } catch (error) {
      throw this.catalogError(error);
    }
    this.documents.set(version, { at: this.options.now().getTime(), document, bundle });
    return { entry: this.toCatalog(entry), document, bundle };
  }

  // -- file feed ----------------------------------------------------------------

  private get feedPath(): string {
    return this.options.config.release.feed.path as string;
  }

  private async readFeedFile(name: string, maxBytes: number): Promise<Uint8Array> {
    if (!isPlainFileName(name)) {
      throw new CatalogError(
        "feed_unavailable",
        "invalid_response",
        `The feed index names ${name}, which is not a plain file name.`,
      );
    }
    const file = path.join(this.feedPath, name);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) {
      throw new CatalogError(
        "feed_unavailable",
        "not_found",
        `The feed file ${name} does not exist.`,
      );
    }
    if (stat.size > maxBytes) {
      throw new CatalogError(
        "feed_unavailable",
        "invalid_response",
        `The feed file ${name} is too large.`,
      );
    }
    return await fs.readFile(file);
  }

  private async listFile(): Promise<FeedEntry[]> {
    const raw = await this.readFeedFile("index.json", FEED_INDEX_MAX_BYTES).catch((error) => {
      throw error instanceof CatalogError
        ? error
        : new CatalogError("feed_unavailable", "not_found", "The feed index is missing.");
    });
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      throw new CatalogError("feed_unavailable", "invalid_response", "The feed index is not JSON.");
    }
    const parsed = feedIndexSchema.safeParse(json);
    if (!parsed.success) {
      throw new CatalogError(
        "feed_unavailable",
        "invalid_response",
        "The feed index does not match its schema.",
      );
    }
    const tagPattern = this.options.config.release.tagPattern;
    const entries: FeedEntry[] = [];
    for (const item of parsed.data.releases) {
      if (versionFromTag(tagPattern, item.tag) !== item.version) {
        continue;
      }
      const local = (name: string | null | undefined) =>
        name && isPlainFileName(name) ? { url: name, accept: "application/json" } : null;
      entries.push({
        version: item.version,
        tag: item.tag,
        prerelease: item.prerelease || isPrerelease(item.version),
        publishedAt: item.publishedAt ?? null,
        notesUrl: item.notesUrl ?? null,
        releaseJson: local(item.releaseJson),
        bundle: local(item.bundle),
      });
    }
    if (entries.length === 0) {
      throw new CatalogError("feed_unavailable", "no_release", "The feed index lists no release.");
    }
    return entries.sort((a, b) => compareVersions(b.version, a.version));
  }

  // -- stored documents ---------------------------------------------------------

  private dirOf(version: string): string {
    if (!isPlainVersion(version)) {
      throw new TypeError("not a plain version");
    }
    return path.join(this.releasesDir, version);
  }

  async store(version: string, document: Uint8Array, bundle: Uint8Array | null): Promise<void> {
    const dir = this.dirOf(version);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await writeAtomic(path.join(dir, "release.json"), document);
    if (bundle) {
      await writeAtomic(path.join(dir, "release.json.sigstore.json"), bundle);
    } else {
      await fs.rm(path.join(dir, "release.json.sigstore.json"), { force: true });
    }
  }

  async load(version: string): Promise<{ document: Uint8Array; bundle: Uint8Array | null } | null> {
    const dir = this.dirOf(version);
    try {
      const document = await fs.readFile(path.join(dir, "release.json"));
      const bundle = await fs
        .readFile(path.join(dir, "release.json.sigstore.json"))
        .catch(() => null);
      return { document, bundle };
    } catch {
      return null;
    }
  }

  async prune(keep: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.releasesDir);
    } catch {
      return;
    }
    const versions = names.filter(isPlainVersion).sort((a, b) => compareVersions(b, a));
    for (const version of versions.slice(keep)) {
      await fs.rm(path.join(this.releasesDir, version), { recursive: true, force: true });
    }
  }

  /** The archive URL of a tag for source mode; null for static and file feeds. */
  archiveUrl(tag: string): string | null {
    const feed = this.options.config.release.feed;
    if (feed.type === "file" || feed.type === "static") {
      return null;
    }
    return this.reader(null).feed.archiveUrl(tag);
  }

  /** Persist something small next to the documents (tests and doctor use the directory). */
  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.releasesDir, { recursive: true, mode: 0o700 });
  }
}
