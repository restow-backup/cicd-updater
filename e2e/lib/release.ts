import { stringify } from "yaml";
import { q } from "./exec.js";
import { DOCKER_CONFIG, KEYS, platform, readFile, sh, UPDATER, WORK, writeFile } from "./host.js";

/**
 * Releases built the way a CI builds them, with the sidecar image's own release CLI:
 * `release build` (docker buildx, push by digest, --metadata-file), `release index`
 * (docker buildx imagetools create and inspect), `release sign-images` (cosign sign),
 * `release json create` and `release json sign` (cosign sign-blob --bundle). The
 * results go into a file feed (index.json, release-<v>.json and its bundle).
 */

export interface ImageSpec {
  repository: string;
  /** Relative to the build root. */
  context: string;
  file?: string;
  buildArgs?: Record<string, string>;
}

export interface PublishedImage {
  repository: string;
  tag: string;
  digest: string;
  platforms: string[];
}

export interface Release {
  version: string;
  tag: string;
  images: Record<string, PublishedImage>;
  /** In the feed directory. */
  document: string;
  bundle: string | null;
}

export interface ReleaseOptions {
  /** Build root inside the host (a copy of the stub or an example). */
  root: string;
  /** File feed directory inside the host. */
  feed: string;
  version: string;
  images: Record<string, ImageSpec>;
  /** release.json `project` (host/owner/repo). */
  project: string;
  /** key: signed with the "main" key pair (or `signer`); none: unsigned. */
  signing: "key" | "none";
  signer?: "main" | "other";
  /** The key pair that signs the images (default: `signer`). */
  imageSigner?: "main" | "other";
  /** key mode only: leave the images unsigned (default: sign them). */
  signImages?: boolean;
  /** key mode only: leave release.json without a bundle (default: sign it). */
  signDocument?: boolean;
  /** The release policy (written to .cicd-updater/release-policy.yaml). */
  policy?: Record<string, unknown>;
  /** Reuse already published images instead of building (for documents only). */
  reuse?: Record<string, PublishedImage>;
}

/** Run the release CLI in a container of the sidecar image (Docker socket, the work tree). */
export async function releaseCli(
  cwd: string,
  args: string[],
  withPassword = false,
): Promise<string> {
  const result = await sh(
    [
      "docker run --rm --network host",
      "-v /var/run/docker.sock:/var/run/docker.sock",
      `-v ${DOCKER_CONFIG}:/root/.docker`,
      `-v ${WORK}:${WORK}`,
      `-w ${q(cwd)}`,
      withPassword ? "-e COSIGN_PASSWORD" : "",
      `${UPDATER} release`,
      ...args.map(q),
    ].join(" "),
    {
      shellEnv: withPassword ? { COSIGN_PASSWORD: await keyPassword() } : {},
      timeoutMs: 900_000,
    },
  );
  return result.stdout;
}

let password: string | null = null;
async function keyPassword(): Promise<string> {
  password ??= await readFile(`${KEYS}/password`);
  return password;
}

function outputValue(stdout: string, key: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${key}=`));
  if (!line) {
    throw new Error(`no ${key}= in the release CLI output:\n${stdout}`);
  }
  return line.slice(key.length + 1);
}

/** Build, push, index, sign and describe one version; add it to the feed index. */
export async function publishRelease(options: ReleaseOptions): Promise<Release> {
  const { root, feed, version } = options;
  const tag = `v${version}`;
  const signer = options.signer ?? "main";
  const keyFile = `${KEYS}/${signer}/cosign.key`;
  let published: Record<string, PublishedImage>;
  if (options.reuse) {
    published = options.reuse;
  } else {
    const specs = Object.fromEntries(
      Object.entries(options.images).map(([key, spec]) => [
        key,
        {
          repository: spec.repository,
          context: spec.context,
          file: spec.file ?? null,
          buildArgs: { VERSION: version, ...(spec.buildArgs ?? {}) },
        },
      ]),
    );
    const built = outputValue(
      await releaseCli(root, [
        "build",
        "--images",
        JSON.stringify(specs),
        "--version",
        version,
        "--platforms",
        await platform(),
      ]),
      "images",
    );
    published = JSON.parse(
      outputValue(
        await releaseCli(root, ["index", "--images", built, "--version", version]),
        "images",
      ),
    ) as Record<string, PublishedImage>;
  }
  if (options.signing === "key" && options.signImages !== false && !options.reuse) {
    await releaseCli(
      root,
      [
        "sign-images",
        "--images",
        JSON.stringify(published),
        "--signing",
        "key",
        "--key",
        `${KEYS}/${options.imageSigner ?? signer}/cosign.key`,
      ],
      true,
    );
  }
  if (options.policy) {
    await writeFile(`${root}/.cicd-updater/release-policy.yaml`, stringify(options.policy));
  }
  const document = `release-${version}.json`;
  await sh(`mkdir -p ${q(feed)}`);
  await releaseCli(root, [
    "json",
    "create",
    "--images",
    JSON.stringify(published),
    "--version",
    version,
    "--tag",
    tag,
    "--signing",
    options.signing,
    "--project",
    options.project,
    ...(options.policy ? ["--policy-file", ".cicd-updater/release-policy.yaml"] : []),
    "--out",
    `${feed}/${document}`,
  ]);
  if (options.policy) {
    await sh(`rm -f ${q(`${root}/.cicd-updater/release-policy.yaml`)}`);
  }
  let bundle: string | null = null;
  if (options.signing === "key" && options.signDocument !== false) {
    bundle = `${document}.sigstore.json`;
    await releaseCli(
      root,
      [
        "json",
        "sign",
        "--file",
        `${feed}/${document}`,
        "--bundle",
        `${feed}/${bundle}`,
        "--signing",
        "key",
        "--key",
        keyFile,
      ],
      true,
    );
  }
  await addToIndex(feed, { version, tag, document, bundle });
  return { version, tag, images: published, document, bundle };
}

/** Add or replace an entry of the feed's index.json. */
export async function addToIndex(
  feed: string,
  entry: { version: string; tag: string; document: string | null; bundle: string | null },
): Promise<void> {
  const file = `${feed}/index.json`;
  let index: { schemaVersion: 1; releases: Record<string, unknown>[] } = {
    schemaVersion: 1,
    releases: [],
  };
  if ((await sh(`test -f ${q(file)}`, { allowFail: true })).code === 0) {
    index = JSON.parse(await readFile(file));
  }
  index.releases = index.releases.filter((release) => release.version !== entry.version);
  index.releases.push({
    version: entry.version,
    tag: entry.tag,
    prerelease: entry.version.includes("-"),
    publishedAt: new Date().toISOString(),
    releaseJson: entry.document,
    bundle: entry.bundle,
  });
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`);
}

/** `repository:tag@digest`, as the sidecar writes it into the env file. */
export function imageRef(image: PublishedImage): string {
  return `${image.repository}:${image.tag}@${image.digest}`;
}
