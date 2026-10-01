import { z } from "zod";
import type { PublishedImages } from "./document.js";
import { type Exec, expectOk } from "./exec.js";

/**
 * The publish step's index work (design 2.2, 10.6 `publish`): after the smoke
 * test passed, one multi-arch index per image is created from the per-platform
 * digests the build pushed untagged, and tagged with the version (plus extra
 * tags). A version tag that already points at different content is refused:
 * a published release is immutable (the fix is a new version). A tag that
 * already holds exactly these platform images is accepted, so a publish job
 * that failed after tagging can be re-run.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
export const RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export const builtImagesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.strictObject({
    repository: z.string().regex(REPOSITORY),
    digests: z.array(z.string().regex(DIGEST)).min(1).max(8),
  }),
);
export type BuiltImages = z.infer<typeof builtImagesSchema>;

export interface IndexOptions {
  images: BuiltImages;
  /** The image tag: the plain version (`1.4.0`). */
  tag: string;
  /** Moving tags such as `1` or `latest`, never checked for immutability. */
  extraTags?: readonly string[];
  refuseExisting?: boolean;
}

export interface RawManifest {
  mediaType?: string;
  manifests?: Array<{
    digest?: string;
    platform?: { os?: string; architecture?: string; variant?: string };
  }>;
}

export async function rawManifest(exec: Exec, ref: string): Promise<RawManifest | null> {
  const result = await exec(["docker", "buildx", "imagetools", "inspect", "--raw", ref]);
  if (result.exitCode !== 0) {
    if (/not found|manifest unknown|404/i.test(result.stderr)) {
      return null;
    }
    expectOk(result, `docker buildx imagetools inspect ${ref}`);
  }
  return JSON.parse(result.stdout) as RawManifest;
}

/** The digests an index lists (attestation manifests of platform unknown/unknown excluded). */
export function indexEntries(manifest: RawManifest): { digest: string; platform: string }[] {
  return (manifest.manifests ?? [])
    .filter((entry) => entry.digest && entry.platform?.os && entry.platform.os !== "unknown")
    .map((entry) => ({
      digest: entry.digest as string,
      platform: `${entry.platform?.os}/${entry.platform?.architecture}${
        entry.platform?.variant ? `/${entry.platform.variant}` : ""
      }`,
    }));
}

/** The platform image digests behind sources that may be indexes themselves (a multi-platform build). */
async function platformDigests(
  exec: Exec,
  repository: string,
  digests: readonly string[],
): Promise<string[]> {
  const result = new Set<string>();
  for (const digest of digests) {
    const manifest = await rawManifest(exec, `${repository}@${digest}`);
    const entries = manifest?.manifests ? indexEntries(manifest) : [];
    if (entries.length > 0) {
      for (const entry of entries) {
        result.add(entry.digest);
      }
    } else {
      result.add(digest);
    }
  }
  return [...result].sort();
}

/** Create and tag the indexes; returns the input for `release json create` and `sign-images`. */
export async function createIndexes(exec: Exec, options: IndexOptions): Promise<PublishedImages> {
  const extraTags = [...(options.extraTags ?? [])];
  for (const tag of [options.tag, ...extraTags]) {
    if (!TAG.test(tag)) {
      throw new Error(`${tag} is not a valid image tag.`);
    }
  }
  const published: PublishedImages = {};
  for (const [key, image] of Object.entries(options.images)) {
    const versionRef = `${image.repository}:${options.tag}`;
    const wanted = [...new Set(image.digests)].sort();
    if (options.refuseExisting !== false) {
      const existing = await rawManifest(exec, versionRef);
      if (existing) {
        const present = indexEntries(existing)
          .map((entry) => entry.digest)
          .sort();
        const expected = await platformDigests(exec, image.repository, wanted);
        if (JSON.stringify(present) !== JSON.stringify(expected)) {
          throw new Error(
            `${versionRef} already exists with other content; a published release is never changed (publish a new version).`,
          );
        }
      }
    }
    const tagArgs = [options.tag, ...extraTags].flatMap((tag) => [
      "--tag",
      `${image.repository}:${tag}`,
    ]);
    expectOk(
      await exec([
        "docker",
        "buildx",
        "imagetools",
        "create",
        ...tagArgs,
        ...wanted.map((digest) => `${image.repository}@${digest}`),
      ]),
      `docker buildx imagetools create ${versionRef}`,
    );
    const inspected = expectOk(
      await exec([
        "docker",
        "buildx",
        "imagetools",
        "inspect",
        versionRef,
        "--format",
        "{{json .Manifest}}",
      ]),
      `docker buildx imagetools inspect ${versionRef}`,
    );
    const digest = (JSON.parse(inspected.stdout) as { digest?: string }).digest;
    if (!digest || !DIGEST.test(digest)) {
      throw new Error(`${versionRef} has no index digest.`);
    }
    const index = await rawManifest(exec, `${image.repository}@${digest}`);
    const entries = index ? indexEntries(index) : [];
    const platforms = RELEASE_PLATFORMS.filter((platform) =>
      entries.some((entry) => entry.platform === platform),
    );
    if (platforms.length === 0) {
      throw new Error(
        `${versionRef} lists no linux/amd64 or linux/arm64 image (found: ${
          entries.map((entry) => entry.platform).join(", ") || "none"
        }).`,
      );
    }
    published[key] = {
      repository: image.repository,
      tag: options.tag,
      digest,
      platforms: [...platforms],
    };
  }
  return published;
}
