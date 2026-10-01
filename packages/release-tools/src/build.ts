import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPlainVersion } from "@cicd-updater/protocol";
import { z } from "zod";
import { type Exec, expectOk } from "./exec.js";
import type { BuiltImages } from "./images.js";

/**
 * `release build` (design 2.2, 10.6 `build` and `release`): build each image
 * with `docker buildx build` for the given platforms and push it by digest,
 * without a tag. Every image gets the OCI labels the sidecar reads
 * (`org.opencontainers.image.version` is the plain version). Provenance and
 * SBOM attestations are off here, so a platform digest is an image manifest;
 * the publish step attaches the SBOM to the signed index instead.
 */

const RELATIVE = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."), {
    message: "must be a relative path inside the repository",
  });

export const buildSpecsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  z.strictObject({
    repository: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/),
    context: RELATIVE.default("."),
    /** Relative to the repository root; null: `<context>/Dockerfile`. */
    file: RELATIVE.nullable().default(null),
    target: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .nullable()
      .default(null),
    buildArgs: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096))
      .default({}),
  }),
);
export type BuildSpecs = z.input<typeof buildSpecsSchema>;

export const SUPPORTED_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export interface BuildOptions {
  images: BuildSpecs;
  platforms: readonly string[];
  version: string;
  /** Commit SHA (`org.opencontainers.image.revision`). */
  revision: string | null;
  /** Repository URL (`org.opencontainers.image.source`). */
  source: string | null;
  /** RFC 3339 time (`org.opencontainers.image.created`), the commit time for reproducibility. */
  created: string | null;
  push: boolean;
  cacheFrom?: readonly string[];
  cacheTo?: readonly string[];
  /** Directory for buildx metadata files. */
  workDir: string;
}

export function ociLabels(
  options: Pick<BuildOptions, "version" | "revision" | "source" | "created">,
): string[] {
  const labels: Record<string, string | null> = {
    "org.opencontainers.image.version": options.version,
    "org.opencontainers.image.revision": options.revision,
    "org.opencontainers.image.source": options.source,
    "org.opencontainers.image.created": options.created,
  };
  return Object.entries(labels).flatMap(([key, value]) =>
    value ? ["--label", `${key}=${value}`] : [],
  );
}

/** The buildx argv of one image. */
export function buildArgv(
  spec: z.output<typeof buildSpecsSchema>[string],
  options: BuildOptions,
  metadataFile: string,
): string[] {
  for (const platform of options.platforms) {
    if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      throw new Error(`Platform ${platform} is not supported (linux/amd64, linux/arm64).`);
    }
  }
  if (options.platforms.length === 0) {
    throw new Error("At least one platform is required.");
  }
  if (!isPlainVersion(options.version)) {
    throw new Error(`${options.version} is not a plain version.`);
  }
  return [
    "docker",
    "buildx",
    "build",
    "--platform",
    options.platforms.join(","),
    ...(spec.file ? ["--file", spec.file] : []),
    ...(spec.target ? ["--target", spec.target] : []),
    ...Object.entries(spec.buildArgs).flatMap(([key, value]) => [
      "--build-arg",
      `${key}=${value.replaceAll("{version}", options.version)}`,
    ]),
    ...ociLabels(options),
    "--provenance=false",
    "--sbom=false",
    ...(options.cacheFrom ?? []).flatMap((value) => ["--cache-from", value]),
    ...(options.cacheTo ?? []).flatMap((value) => ["--cache-to", value]),
    "--output",
    `type=image,name=${spec.repository},push-by-digest=true,name-canonical=true,push=${options.push}`,
    "--metadata-file",
    metadataFile,
    spec.context,
  ];
}

/** Build and push every image; the result feeds `release smoke` and `release index`. */
export async function buildImages(exec: Exec, options: BuildOptions): Promise<BuiltImages> {
  const specs = buildSpecsSchema.parse(options.images);
  const built: BuiltImages = {};
  await fs.mkdir(options.workDir, { recursive: true });
  for (const [key, spec] of Object.entries(specs)) {
    const metadataFile = path.join(options.workDir, `build-${key}.json`);
    expectOk(
      await exec(buildArgv(spec, options, metadataFile) as [string, ...string[]], {
        timeoutMs: 120 * 60_000,
      }),
      `docker buildx build of ${key}`,
    );
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8")) as Record<string, unknown>;
    const digest = metadata["containerimage.digest"];
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`The build of ${key} reported no image digest.`);
    }
    built[key] = { repository: spec.repository, digests: [digest] };
  }
  return built;
}
