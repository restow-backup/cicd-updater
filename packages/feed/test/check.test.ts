import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFeed, sha256Hex } from "../src/index.js";
import { bytes, FakeWeb, json } from "./fake-web.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../protocol/test/fixtures/release.json", import.meta.url), "utf8"),
) as Record<string, any>;

const LIST = "https://api.github.com/repos/acme/notes/releases?per_page=30";
const download = (tag: string, name: string) =>
  `https://github.com/acme/notes/releases/download/${tag}/${name}`;

function document(
  version: string,
  change: (doc: Record<string, any>) => void = () => undefined,
): string {
  const doc = structuredClone(fixture);
  doc.version = version;
  doc.tag = `v${version}`;
  doc.channel = version.includes("-") ? "beta" : "stable";
  doc.upgrade.minimumFromVersion = null;
  for (const image of Object.values(doc.images) as Record<string, string>[]) {
    image.tag = version;
  }
  change(doc);
  return JSON.stringify(doc);
}

function release(tag: string, options: { prerelease?: boolean; assets?: boolean } = {}) {
  return {
    tag_name: tag,
    prerelease: options.prerelease ?? false,
    html_url: `https://github.com/acme/notes/releases/tag/${tag}`,
    assets:
      options.assets === false
        ? []
        : [
            {
              name: "release.json",
              url: "https://api.github.com/x",
              browser_download_url: download(tag, "release.json"),
            },
          ],
  };
}

const now = () => new Date("2026-11-02T18:00:00Z");

describe("checkFeed", () => {
  it("lists the channel's releases with documents, refusals and the next installable one", async () => {
    const docs: Record<string, string> = {
      "1.5.0": document("1.5.0", (doc) => {
        doc.upgrade.minimumFromVersion = "1.3.0";
      }),
      "1.4.0": document("1.4.0", (doc) => {
        doc.upgrade.manualSteps = {
          required: true,
          summary: "Edit the Compose file.",
          url: "https://example.com/steps",
        };
      }),
      "1.3.0": document("1.3.0"),
    };
    const web = new FakeWeb().on(LIST, [
      release("v1.6.0-rc.1", { prerelease: true }),
      release("v1.5.0"),
      release("v1.4.0"),
      release("v1.3.0"),
      release("v1.2.5", { assets: false }),
      release("v1.2.0"),
    ]);
    for (const [version, text] of Object.entries(docs)) {
      web.on(download(`v${version}`, "release.json"), bytes(text));
    }
    const result = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: "1.2.0",
      fetch: web.fetch,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.releases.map((r) => [r.version, r.refusals])).toEqual([
      ["1.5.0", ["below_minimum_version"]],
      ["1.4.0", ["manual_steps_required"]],
      ["1.3.0", []],
      ["1.2.5", ["no_release_document"]],
      ["1.2.0", ["not_newer"]],
    ]);
    expect(result.latest?.version).toBe("1.5.0");
    expect(result.updateAvailable).toBe(true);
    expect(result.nextInstallable?.version).toBe("1.3.0");
    expect(result.nextInstallable?.documentSha256).toBe(
      sha256Hex(Buffer.from(docs["1.3.0"] as string)),
    );
    expect(result.nextInstallable?.document?.images.app?.repository).toBe("ghcr.io/acme/notes");
    expect(result.checkedAt).toBe("2026-11-02T18:00:00.000Z");
    // The not-newer release's document is never downloaded.
    expect(web.requests.some((request) => request.url.includes("v1.2.0/"))).toBe(false);
  });

  it("offers pre-releases on the beta channel and trusts the document's channel", async () => {
    const web = new FakeWeb()
      .on(LIST, [release("v1.6.0-rc.1", { prerelease: true }), release("v1.5.0")])
      .on(download("v1.6.0-rc.1", "release.json"), bytes(document("1.6.0-rc.1")))
      .on(download("v1.5.0", "release.json"), bytes(document("1.5.0")));
    const beta = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "beta",
      running: "1.5.0",
      fetch: web.fetch,
    });
    expect(beta.ok && beta.releases.map((r) => [r.version, r.channel, r.refusals])).toEqual([
      ["1.6.0-rc.1", "beta", []],
      ["1.5.0", "stable", ["not_newer"]],
    ]);
  });

  it("drops a release whose signed document is a pre-release although the host did not flag it", async () => {
    const web = new FakeWeb()
      .on(LIST, [release("v1.6.0-rc.1"), release("v1.5.0")])
      .on(download("v1.6.0-rc.1", "release.json"), bytes(document("1.6.0-rc.1")))
      .on(download("v1.5.0", "release.json"), bytes(document("1.5.0")));
    const stable = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: "1.4.0",
      fetch: web.fetch,
    });
    // The provider flag pre-filters; the version itself says pre-release, so it is not offered on stable.
    expect(stable.ok && stable.releases.map((r) => r.version)).toEqual(["1.5.0"]);
  });

  it("treats documents that do not belong to the release as missing", async () => {
    const web = new FakeWeb()
      .on(LIST, [release("v1.5.0"), release("v1.4.0")])
      .on(download("v1.5.0", "release.json"), bytes(document("1.4.0")))
      .on(download("v1.4.0", "release.json"), bytes("not json"));
    const result = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: null,
      fetch: web.fetch,
    });
    expect(result.ok && result.releases.map((r) => r.refusals)).toEqual([
      ["no_release_document"],
      ["no_release_document"],
    ]);
    expect(result.ok && result.updateAvailable).toBeNull();
    expect(result.ok && result.nextInstallable).toBeNull();
  });

  it("resolves at most the configured number of documents", async () => {
    const web = new FakeWeb()
      .on(LIST, [release("v1.5.0"), release("v1.4.0")])
      .on(download("v1.5.0", "release.json"), bytes(document("1.5.0")));
    const result = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: "1.0.0",
      resolveDocuments: 1,
      fetch: web.fetch,
    });
    expect(result.ok && result.releases.map((r) => r.document !== null)).toEqual([true, false]);
  });

  it("returns feed errors instead of throwing", async () => {
    const web = new FakeWeb().on(LIST, json({ message: "Not Found" }, 404));
    const result = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: "1.0.0",
      fetch: web.fetch,
      token: "ghp_abcdefghijklmnop1234",
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
    expect(web.requests[0]?.headers.authorization).toBe("Bearer ghp_abcdefghijklmnop1234");
    const empty = await checkFeed({
      feed: { type: "github", url: "https://github.com/acme/notes" },
      channel: "stable",
      running: "1.0.0",
      fetch: new FakeWeb().on(LIST, []).fetch,
    });
    expect(!empty.ok && empty.error.code).toBe("no_release");
    const invalid = await checkFeed({
      feed: { type: "github", url: "https://example.com/acme/notes" },
      channel: "stable",
      running: "1.0.0",
    });
    expect(!invalid.ok && invalid.error.code).toBe("invalid_response");
  });
});
