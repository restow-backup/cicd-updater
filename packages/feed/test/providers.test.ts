import { describe, expect, it } from "vitest";
import { resolveFeed } from "../src/index.js";

describe("github", () => {
  const feed = resolveFeed({ type: "github", url: "https://github.com/acme/notes" });

  it("reads the release list of the repository through the API", () => {
    expect(feed.listUrl).toBe("https://api.github.com/repos/acme/notes/releases?per_page=30");
    expect(feed.origin).toBe("https://api.github.com");
    expect(feed.project).toBe("github.com/acme/notes");
    expect(feed.archiveUrl("v1.0.0")).toBe(
      "https://api.github.com/repos/acme/notes/tarball/v1.0.0",
    );
  });

  const body = [
    {
      tag_name: "v1.1.0",
      draft: false,
      prerelease: false,
      published_at: "2026-11-02T18:20:00Z",
      html_url: "https://github.com/acme/notes/releases/tag/v1.1.0",
      assets: [
        {
          name: "release.json",
          url: "https://api.github.com/repos/acme/notes/releases/assets/11",
          browser_download_url:
            "https://github.com/acme/notes/releases/download/v1.1.0/release.json",
        },
        {
          name: "release.json.sigstore.json",
          url: "https://api.github.com/repos/acme/notes/releases/assets/12",
          browser_download_url:
            "https://github.com/acme/notes/releases/download/v1.1.0/release.json.sigstore.json",
        },
      ],
    },
    { tag_name: "v1.2.0", draft: true, assets: [] },
    { tag_name: "nightly", assets: [] },
    {
      tag_name: "v1.2.0-rc.1",
      prerelease: true,
      assets: [],
      html_url: "http://insecure.example.com",
    },
    { tag_name: "1.0.0", assets: [] },
  ];

  it("drops drafts and tags that are not versions under the pattern", () => {
    const entries = feed.parse(body, "v{version}", false);
    expect(entries.map((entry) => entry.version)).toEqual(["1.1.0", "1.2.0-rc.1"]);
    expect(entries[1]).toMatchObject({
      prerelease: true,
      notesUrl: null,
      releaseJson: null,
      bundle: null,
    });
  });

  it("uses the download URLs for public and the API URLs (with the token) for private repositories", () => {
    const [publicEntry] = feed.parse(body, "v{version}", false);
    expect(publicEntry?.releaseJson).toEqual({
      url: "https://github.com/acme/notes/releases/download/v1.1.0/release.json",
      accept: "application/octet-stream",
    });
    const [privateEntry] = feed.parse(body, "v{version}", true);
    expect(privateEntry?.bundle?.url).toBe(
      "https://api.github.com/repos/acme/notes/releases/assets/12",
    );
    expect(privateEntry?.publishedAt).toBe("2026-11-02T18:20:00.000Z");
  });

  it("respects a custom tag pattern", () => {
    expect(feed.parse(body, "{version}", false).map((entry) => entry.tag)).toEqual(["1.0.0"]);
  });

  it("refuses URLs that are not repositories", () => {
    expect(() => resolveFeed({ type: "github", url: "https://github.com/acme" })).toThrow();
    expect(() => resolveFeed({ type: "github", url: "https://gitlab.com/acme/notes" })).toThrow();
    expect(() => resolveFeed({ type: "github", url: "http://github.com/acme/notes" })).toThrow();
  });
});

describe("gitea and forgejo", () => {
  it("supports a path prefix and sends the token as 'token'", () => {
    const feed = resolveFeed({ type: "gitea", url: "https://git.example.com/forge/acme/notes" });
    expect(feed.listUrl).toBe(
      "https://git.example.com/forge/api/v1/repos/acme/notes/releases?limit=30",
    );
    expect(feed.authScheme).toBe("token");
    expect(feed.project).toBe("git.example.com/forge/acme/notes");
    expect(feed.archiveUrl("v2.0.0")).toBe(
      "https://git.example.com/forge/api/v1/repos/acme/notes/archive/v2.0.0.tar.gz",
    );
    const entries = feed.parse(
      [
        {
          tag_name: "v2.0.0",
          prerelease: false,
          assets: [
            {
              name: "release.json",
              browser_download_url: "https://git.example.com/forge/attachments/abc",
            },
          ],
        },
      ],
      "v{version}",
      true,
    );
    expect(entries[0]?.releaseJson?.url).toBe("https://git.example.com/forge/attachments/abc");
    expect(entries[0]?.bundle).toBeNull();
  });
});

describe("gitlab", () => {
  const feed = resolveFeed({ type: "gitlab", url: "https://gitlab.example.com/group/sub/notes" });

  it("encodes the project path and reads asset links", () => {
    expect(feed.listUrl).toBe(
      "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fnotes/releases?per_page=30",
    );
    expect(feed.project).toBe("gitlab.example.com/group/sub/notes");
    const entries = feed.parse(
      [
        { tag_name: "v3.0.0", upcoming_release: true, assets: { links: [] } },
        {
          tag_name: "v2.9.0",
          released_at: "2026-10-01T10:00:00Z",
          _links: { self: "https://gitlab.example.com/group/sub/notes/-/releases/v2.9.0" },
          assets: {
            links: [
              {
                name: "release.json",
                url: "https://gitlab.example.com/x",
                direct_asset_url: "https://gitlab.example.com/direct/release.json",
              },
              { name: "release.json.sigstore.json", url: "https://gitlab.example.com/y" },
            ],
          },
        },
      ],
      "v{version}",
      false,
    );
    expect(entries.map((entry) => entry.version)).toEqual(["2.9.0"]);
    expect(entries[0]?.releaseJson?.url).toBe("https://gitlab.example.com/direct/release.json");
    expect(entries[0]?.bundle?.url).toBe("https://gitlab.example.com/y");
    expect(entries[0]?.notesUrl).toBe(
      "https://gitlab.example.com/group/sub/notes/-/releases/v2.9.0",
    );
  });
});

describe("static index", () => {
  const feed = resolveFeed({
    type: "static",
    url: "https://downloads.example.com/notes/index.json",
  });

  it("reads the feed index and keeps only https URLs", () => {
    const entries = feed.parse(
      {
        schemaVersion: 1,
        releases: [
          {
            version: "1.4.0",
            tag: "v1.4.0",
            prerelease: false,
            publishedAt: "2026-11-02T18:20:00Z",
            releaseJson: "https://downloads.example.com/notes/1.4.0/release.json",
            bundle: "http://downloads.example.com/notes/1.4.0/release.json.sigstore.json",
          },
          { version: "1.5.0", tag: "release-1.5.0", prerelease: false },
        ],
      },
      "v{version}",
      false,
    );
    expect(entries).toEqual([
      {
        version: "1.4.0",
        tag: "v1.4.0",
        prerelease: false,
        publishedAt: "2026-11-02T18:20:00.000Z",
        notesUrl: null,
        releaseJson: {
          url: "https://downloads.example.com/notes/1.4.0/release.json",
          accept: "application/json",
        },
        bundle: null,
      },
    ]);
    expect(feed.archiveUrl("v1.4.0")).toBeNull();
  });

  it("refuses an index that does not match the schema", () => {
    expect(() => feed.parse({ schemaVersion: 2, releases: [] }, "v{version}", false)).toThrow();
  });
});
