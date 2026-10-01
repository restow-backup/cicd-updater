import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../lib/exec.js";
import { IMAGES, KEYS, platform, sh, UPDATER, WORK, writeFile } from "../lib/host.js";
import { releaseCli } from "../lib/release.js";
import { StubApp } from "../lib/stub.js";

/**
 * The release side against real tools (design 10.6): docker buildx build
 * --metadata-file (push by digest), docker buildx imagetools create/inspect (platform
 * manifests and index sources, --raw), cosign attest with the release tools' flags, and
 * the release smoke that upgrades from the previous release through the sidecar (Compose
 * !override, a file feed, trust mode none).
 */

let app: StubApp;

interface RawIndex {
  mediaType: string;
  manifests: {
    mediaType: string;
    digest: string;
    platform?: { architecture: string; os: string };
  }[];
}

async function rawManifest(ref: string): Promise<RawIndex> {
  const result = await sh(
    `docker run --rm --network host --entrypoint docker ${UPDATER} buildx imagetools inspect --raw ${q(ref)}`,
  );
  return JSON.parse(result.stdout) as RawIndex;
}

beforeAll(async () => {
  app = await StubApp.create({ name: "tools" });
  await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
  await app.release({ version: "1.1.0", migration: 1 });
});

afterAll(async () => {
  await app.project.down();
  await sh("docker rm -f e2e-feed > /dev/null 2>&1 || true");
});

describe("buildx and imagetools", () => {
  it("builds by digest (--metadata-file) and indexes the platform manifest without attestations", async () => {
    const images = JSON.stringify({
      app: { repository: app.repository.app, context: ".", buildArgs: { VERSION: "2.0.0" } },
    });
    const out = await releaseCli(app.root, [
      "build",
      "--images",
      images,
      "--version",
      "2.0.0",
      "--platforms",
      await platform(),
    ]);
    const built = JSON.parse(/^images=(.*)$/m.exec(out)?.[1] ?? "{}") as Record<
      string,
      { digests: string[] }
    >;
    const platformDigest = built.app?.digests[0] ?? "";
    expect(platformDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The metadata file's digest is a single image manifest in the registry.
    const manifest = await rawManifest(`${app.repository.app}@${platformDigest}`);
    expect(manifest.mediaType).toMatch(/manifest\.v1\+json|manifest\.v2\+json/);

    const index = await rawManifest(`${app.repository.app}:1.0.0`);
    expect(index.mediaType).toBe("application/vnd.oci.image.index.v1+json");
    expect(index.manifests).toHaveLength(1);
    expect(index.manifests[0]?.platform?.os).toBe("linux");
    // Provenance and SBOM attestations are off in the build: no unknown/unknown entries.
    expect(index.manifests.some((entry) => entry.platform?.os === "unknown")).toBe(false);
  });

  it("expands an index source into its platform manifests (release index)", async () => {
    const source = app.releases.get("1.0.0")?.images.app?.digest ?? "";
    const out = await releaseCli(app.root, [
      "index",
      "--images",
      JSON.stringify({ app: { repository: app.repository.app, digests: [source] } }),
      "--version",
      "3.0.0",
    ]);
    const published = JSON.parse(/^images=(.*)$/m.exec(out)?.[1] ?? "{}") as Record<
      string,
      { digest: string; platforms: string[] }
    >;
    const index = await rawManifest(`${app.repository.app}@${published.app?.digest}`);
    const original = await rawManifest(`${app.repository.app}@${source}`);
    expect(index.manifests.map((entry) => entry.digest)).toEqual(
      original.manifests.map((entry) => entry.digest),
    );
    expect(
      index.manifests.every(
        (entry) => entry.mediaType !== "application/vnd.oci.image.index.v1+json",
      ),
    ).toBe(true);
    // An existing version tag is refused (immutability).
    const again = await sh(
      `docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v ${WORK}/docker:/root/.docker ${UPDATER} release index --images ${q(
        JSON.stringify({ app: { repository: app.repository.app, digests: [source] } }),
      )} --version 1.1.0`,
      { allowFail: true },
    );
    expect(again.code).not.toBe(0);
  });

  it("attests an SPDX SBOM with the release tools' key flags, and cosign verifies it", async () => {
    const ref = `${app.repository.app}@${app.releases.get("1.1.0")?.images.app?.digest}`;
    await writeFile(
      `${WORK}/sbom/app.spdx.json`,
      JSON.stringify({
        spdxVersion: "SPDX-2.3",
        SPDXID: "SPDXRef-DOCUMENT",
        name: "stub",
        dataLicense: "CC0-1.0",
        documentNamespace: "https://example.com/spdx/stub",
        creationInfo: { created: "2026-10-01T00:00:00Z", creators: ["Tool: e2e"] },
        packages: [],
      }),
    );
    // The argv of attestSbomArgs in key mode without the transparency log.
    await sh(
      `docker run --rm --network host -v ${KEYS}:${KEYS}:ro -v ${WORK}/sbom:${WORK}/sbom:ro -v ${WORK}/docker:/root/.docker -e COSIGN_PASSWORD -e HOME=/tmp --entrypoint cosign ${UPDATER} \\
  attest --yes --key ${KEYS}/main/cosign.key --use-signing-config=false --tlog-upload=false --type spdxjson --predicate ${WORK}/sbom/app.spdx.json ${q(ref)}`,
      { shellEnv: { COSIGN_PASSWORD: (await sh(`cat ${KEYS}/password`)).stdout } },
    );
    const verified = await sh(
      `docker run --rm --network host --read-only --cap-drop ALL --user 65534:65534 --tmpfs /tmp:rw,size=64m -e HOME=/tmp -v ${KEYS}:${KEYS}:ro --entrypoint cosign ${UPDATER} \\
  verify-attestation --key ${KEYS}/main/cosign.pub --insecure-ignore-tlog=true --type spdxjson ${q(ref)} 2> /dev/null`,
    );
    expect(verified.stdout).toContain("payloadType");
  });
});

describe("release smoke", () => {
  it("upgrades from the previous release through the sidecar (Compose !override, file feed, none)", async () => {
    const dir = app.project.dir;
    // The project files the smoke reads from the checkout.
    await app.project.writeCompose(app.composeFile());
    await app.project.writeUpdater(app.updaterConfig());
    await writeFile(
      `${dir}/docker-compose.smoke.yml`,
      'services:\n  api:\n    ports: ["127.0.0.1:13000:3000"]\n',
    );
    await writeFile(`${dir}/.env.example`, "PROJECT_DIR=\nAPP_IMAGE=\nPOSTGRES_PASSWORD=\n");
    // Earlier releases come from a static feed index over HTTPS (the test CA).
    const feed = app.project.feed;
    const releases = ["1.0.0"].map((version) => ({
      version,
      tag: `v${version}`,
      prerelease: false,
      releaseJson: `https://10.213.0.1:8443/release-${version}.json`,
      bundle: `https://10.213.0.1:8443/release-${version}.json.sigstore.json`,
    }));
    await writeFile(`${feed}/static.json`, JSON.stringify({ schemaVersion: 1, releases }));
    await writeFile(
      `${WORK}/feed-nginx.conf`,
      "server { listen 8443 ssl; ssl_certificate /pki/registry.crt; ssl_certificate_key /pki/registry.key; root /feed; }\n",
    );
    await sh(
      `docker rm -f e2e-feed > /dev/null 2>&1 || true
docker run -d --name e2e-feed -p 8443:8443 -v ${q(feed)}:/feed:ro -v ${WORK}/pki:/pki:ro -v ${WORK}/feed-nginx.conf:/etc/nginx/conf.d/default.conf:ro ${IMAGES.nginx} > /dev/null`,
    );
    const target = app.releases.get("1.1.0")?.images.app;
    const result = await sh(
      [
        "docker run --rm --network host",
        "-v /var/run/docker.sock:/var/run/docker.sock",
        `-v ${WORK}:${WORK}`,
        `-w ${q(dir)}`,
        `-e NODE_EXTRA_CA_CERTS=${WORK}/pki/ca.crt`,
        `${UPDATER} release smoke`,
        "--compose-files docker-compose.yml,docker-compose.smoke.yml",
        "--env-example .env.example",
        `--images ${q(JSON.stringify({ app: { repository: target?.repository, digest: target?.digest } }))}`,
        `--image-vars ${q(JSON.stringify({ app: "APP_IMAGE" }))}`,
        "--health-url http://127.0.0.1:13000/healthz",
        "--health-version-path '$.version'",
        "--expect-version 1.1.0",
        "--upgrade-from 1.0.0 --feed-type static --feed-url https://10.213.0.1:8443/static.json",
        "--feed-allow-private-host 10.213.0.1",
        `--updater-config updater.yaml --updater-image ${UPDATER}`,
        `--env POSTGRES_PASSWORD=smoke-db-password --env PROJECT_DIR=${q(dir)}`,
        `--report ${q(`${WORK}/smoke-report.md`)}`,
      ].join(" "),
      { allowFail: true, timeoutMs: 900_000 },
    );
    const report = await sh(`cat ${WORK}/smoke-report.md 2>/dev/null || true`);
    expect(result.code, `${result.stdout}\n${result.stderr}\n${report.stdout}`).toBe(0);
    expect(report.stdout).toMatch(/upgrade/i);
    // Torn down: no container of the smoke project is left.
    const left = await sh("docker ps -a --format '{{.Names}}' | grep -c smoke || true");
    expect(left.stdout.trim()).toBe("0");
  });
});
