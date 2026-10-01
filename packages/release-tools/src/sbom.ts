import * as fs from "node:fs/promises";
import * as path from "node:path";
import { attestSbomArgs, runSigning, type SigningOptions } from "./cosign.js";
import type { PublishedImages } from "./document.js";
import { type Exec, expectOk } from "./exec.js";
import { indexEntries, RELEASE_PLATFORMS, rawManifest } from "./images.js";

/**
 * `release sbom` (design 10.6 `publish`, input `sbom`): an SPDX SBOM per image
 * and platform, generated with syft from the pushed image and, unless the
 * signing mode is none, attached to that platform image as a cosign
 * attestation signed like the image. The files are kept for the release assets.
 */

export interface SbomOptions extends SigningOptions {
  outDir: string;
  password: string | null;
}

export async function generateSboms(
  exec: Exec,
  images: PublishedImages,
  options: SbomOptions,
): Promise<string[]> {
  await fs.mkdir(options.outDir, { recursive: true });
  const files: string[] = [];
  for (const [key, image] of Object.entries(images)) {
    const index = await rawManifest(exec, `${image.repository}@${image.digest}`);
    const entries = index?.manifests
      ? indexEntries(index).filter((entry) =>
          (RELEASE_PLATFORMS as readonly string[]).includes(entry.platform),
        )
      : [{ digest: image.digest, platform: image.platforms[0] ?? "linux/amd64" }];
    for (const entry of entries) {
      const ref = `${image.repository}@${entry.digest}`;
      const file = path.join(
        options.outDir,
        `${key}-${image.tag}-${entry.platform.replaceAll("/", "-")}.spdx.json`,
      );
      expectOk(
        await exec(["syft", "scan", ref, "--output", `spdx-json=${file}`], {
          timeoutMs: 30 * 60_000,
        }),
        `syft scan ${ref}`,
      );
      await runSigning(exec, attestSbomArgs(ref, file, options), options.password);
      files.push(file);
    }
  }
  return files;
}
