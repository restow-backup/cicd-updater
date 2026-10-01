import {
  feedIndexSchema,
  isPrerelease,
  RELEASE_BUNDLE_NAME,
  RELEASE_DOCUMENT_NAME,
  versionFromTag,
} from "@cicd-updater/protocol";

/**
 * Feed providers (design 3.3): how the release list is found and read for
 * GitHub, Forgejo/Gitea, GitLab and a static feed index. The `file` provider
 * is sidecar-only and lives there.
 */

export type RemoteFeedType = "github" | "gitea" | "gitlab" | "static";

export interface FeedSource {
  type: RemoteFeedType;
  /** Repository URL (github, gitea, gitlab) or the index URL (static). */
  url: string;
}

export interface AssetLocation {
  url: string;
  accept: string;
}

/** One release of the feed, before its documents are read. */
export interface FeedEntry {
  version: string;
  tag: string;
  /** The provider's pre-release flag or a pre-release version (only used to pre-filter). */
  prerelease: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  releaseJson: AssetLocation | null;
  bundle: AssetLocation | null;
}

export interface ResolvedFeed {
  type: RemoteFeedType;
  /** Where the release list is read. */
  listUrl: string;
  /** The origin a token is sent to (the feed's own origin). */
  origin: string;
  authScheme: "token" | "Bearer";
  /** `host/owner/repo` (GitLab: `host/group/.../project`), lowercase; null for static. */
  project: string | null;
  /** The tag's source archive (tar.gz) for source mode; null for static. */
  archiveUrl(tag: string): string | null;
  /** Entries of a list response (drafts and tags that are not versions dropped). */
  parse(body: unknown, tagPattern: string, withToken: boolean): FeedEntry[];
}

const PAGE_SIZE = 30;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const OCTET = "application/octet-stream";

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function httpsOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entries(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body) ? body : [body];
  return list.map(record).filter((item): item is Record<string, unknown> => item !== null);
}

function baseEntry(
  tag: unknown,
  tagPattern: string,
  prereleaseFlag: unknown,
  publishedAt: unknown,
  notesUrl: unknown,
): Omit<FeedEntry, "releaseJson" | "bundle"> | null {
  if (typeof tag !== "string") {
    return null;
  }
  const version = versionFromTag(tagPattern, tag.trim());
  if (!version) {
    return null;
  }
  return {
    version,
    tag: tag.trim(),
    prerelease: prereleaseFlag === true || isPrerelease(version),
    publishedAt: isoOrNull(publishedAt),
    notesUrl: httpsOrNull(notesUrl),
  };
}

function segmentsOf(url: URL): string[] {
  return url.pathname
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function github(url: URL): ResolvedFeed {
  const [owner, rawRepo] = segmentsOf(url);
  const repo = rawRepo?.replace(/\.git$/i, "");
  if (url.hostname !== "github.com" || !owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    throw new TypeError("a GitHub feed is https://github.com/<owner>/<repo>");
  }
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  return {
    type: "github",
    listUrl: `${api}/releases?per_page=${PAGE_SIZE}`,
    origin: "https://api.github.com",
    authScheme: "Bearer",
    project: `github.com/${owner}/${repo}`.toLowerCase(),
    archiveUrl: (tag) => `${api}/tarball/${encodeURIComponent(tag)}`,
    parse(body, tagPattern, withToken) {
      const out: FeedEntry[] = [];
      for (const item of entries(body)) {
        if (item.draft === true) {
          continue;
        }
        const entry = baseEntry(
          item.tag_name,
          tagPattern,
          item.prerelease,
          item.published_at ?? item.created_at,
          item.html_url,
        );
        if (!entry) {
          continue;
        }
        const assets = Array.isArray(item.assets) ? item.assets.map(record) : [];
        const locate = (name: string): AssetLocation | null => {
          const asset = assets.find((candidate) => candidate?.name === name);
          if (!asset) {
            return null;
          }
          // Private repositories: the API asset URL with the token; public: the download URL.
          const target = withToken
            ? httpsOrNull(asset.url)
            : httpsOrNull(asset.browser_download_url);
          return target ? { url: target, accept: OCTET } : null;
        };
        out.push({
          ...entry,
          releaseJson: locate(RELEASE_DOCUMENT_NAME),
          bundle: locate(RELEASE_BUNDLE_NAME),
        });
      }
      return out;
    },
  };
}

function gitea(url: URL): ResolvedFeed {
  const segments = segmentsOf(url);
  if (segments.length < 2) {
    throw new TypeError("a Gitea/Forgejo feed is https://<host>[/<prefix>]/<owner>/<repo>");
  }
  const repo = (segments.at(-1) as string).replace(/\.git$/i, "");
  const owner = segments.at(-2) as string;
  if (!NAME.test(owner) || !NAME.test(repo)) {
    throw new TypeError("a Gitea/Forgejo feed is https://<host>[/<prefix>]/<owner>/<repo>");
  }
  const prefix = segments.slice(0, -2);
  const base = `${url.origin}${prefix.length ? `/${prefix.map(encodeURIComponent).join("/")}` : ""}`;
  const api = `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    type: "gitea",
    listUrl: `${api}/releases?limit=${PAGE_SIZE}`,
    origin: url.origin,
    authScheme: "token",
    project: [url.host, ...prefix, owner, repo].join("/").toLowerCase(),
    archiveUrl: (tag) => `${api}/archive/${encodeURIComponent(tag)}.tar.gz`,
    parse(body, tagPattern) {
      const out: FeedEntry[] = [];
      for (const item of entries(body)) {
        if (item.draft === true) {
          continue;
        }
        const entry = baseEntry(
          item.tag_name,
          tagPattern,
          item.prerelease,
          item.published_at ?? item.created_at,
          item.html_url,
        );
        if (!entry) {
          continue;
        }
        const assets = Array.isArray(item.assets) ? item.assets.map(record) : [];
        const locate = (name: string): AssetLocation | null => {
          const asset = assets.find((candidate) => candidate?.name === name);
          const target = asset ? httpsOrNull(asset.browser_download_url) : null;
          return target ? { url: target, accept: OCTET } : null;
        };
        out.push({
          ...entry,
          releaseJson: locate(RELEASE_DOCUMENT_NAME),
          bundle: locate(RELEASE_BUNDLE_NAME),
        });
      }
      return out;
    },
  };
}

function gitlab(url: URL): ResolvedFeed {
  const segments = segmentsOf(url);
  if (
    segments.length < 2 ||
    segments.length > 8 ||
    !segments.every((segment) => NAME.test(segment))
  ) {
    throw new TypeError("a GitLab feed is https://<host>/<group>[/<subgroup>...]/<project>");
  }
  const path = segments.join("/").replace(/\.git$/i, "");
  const api = `${url.origin}/api/v4/projects/${encodeURIComponent(path)}`;
  return {
    type: "gitlab",
    listUrl: `${api}/releases?per_page=${PAGE_SIZE}`,
    origin: url.origin,
    authScheme: "Bearer",
    project: `${url.host}/${path}`.toLowerCase(),
    archiveUrl: (tag) => `${api}/repository/archive.tar.gz?sha=${encodeURIComponent(tag)}`,
    parse(body, tagPattern) {
      const out: FeedEntry[] = [];
      for (const item of entries(body)) {
        if (item.upcoming_release === true) {
          continue;
        }
        const links = record(item._links);
        const entry = baseEntry(
          item.tag_name,
          tagPattern,
          false,
          item.released_at ?? item.created_at,
          links?.self,
        );
        if (!entry) {
          continue;
        }
        const assetLinks = Array.isArray(record(item.assets)?.links)
          ? ((record(item.assets)?.links as unknown[]) ?? []).map(record)
          : [];
        const locate = (name: string): AssetLocation | null => {
          const link = assetLinks.find((candidate) => candidate?.name === name);
          const target = link
            ? (httpsOrNull(link.direct_asset_url) ?? httpsOrNull(link.url))
            : null;
          return target ? { url: target, accept: OCTET } : null;
        };
        out.push({
          ...entry,
          releaseJson: locate(RELEASE_DOCUMENT_NAME),
          bundle: locate(RELEASE_BUNDLE_NAME),
        });
      }
      return out;
    },
  };
}

function staticIndex(url: URL): ResolvedFeed {
  return {
    type: "static",
    listUrl: url.toString(),
    origin: url.origin,
    authScheme: "Bearer",
    project: null,
    archiveUrl: () => null,
    parse(body, tagPattern) {
      const parsed = feedIndexSchema.safeParse(body);
      if (!parsed.success) {
        throw new TypeError("the feed index does not match its schema");
      }
      const out: FeedEntry[] = [];
      for (const item of parsed.data.releases) {
        if (versionFromTag(tagPattern, item.tag) !== item.version) {
          continue;
        }
        const releaseJson = httpsOrNull(item.releaseJson);
        const bundle = httpsOrNull(item.bundle);
        out.push({
          version: item.version,
          tag: item.tag,
          prerelease: item.prerelease || isPrerelease(item.version),
          publishedAt: isoOrNull(item.publishedAt),
          notesUrl: httpsOrNull(item.notesUrl),
          releaseJson: releaseJson ? { url: releaseJson, accept: "application/json" } : null,
          bundle: bundle ? { url: bundle, accept: "application/json" } : null,
        });
      }
      return out;
    },
  };
}

/** Resolve a feed source; throws TypeError for a URL that does not fit the provider. */
export function resolveFeed(source: FeedSource): ResolvedFeed {
  let url: URL;
  try {
    url = new URL(source.url);
  } catch {
    throw new TypeError("the feed URL is not a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new TypeError("the feed URL must be https without credentials");
  }
  switch (source.type) {
    case "github":
      return github(url);
    case "gitea":
      return gitea(url);
    case "gitlab":
      return gitlab(url);
    case "static":
      return staticIndex(url);
  }
}
