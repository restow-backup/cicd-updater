import { parse, stringify } from "yaml";
import { q } from "./exec.js";
import { KEYS, PROJECTS, REGISTRY, readFile, sh, UPDATER, WORK, writeFile } from "./host.js";
import { Project } from "./project.js";
import { imageRef, publishRelease, type Release } from "./release.js";

/**
 * An example of examples/ as a project inside the host: a copy of its directory (the build
 * root and the Compose project at once), its own updater.yaml with two changes for the
 * test (the releases come from a file feed, and they are signed with the e2e key instead
 * of keyless), and its .env made from .env.example as an operator would.
 *
 * node-postgres depends on the SDK from the GitHub release tarball, which exists only after
 * the release: the copy installs the tarball packed from this repository instead
 * (E2E_SDK_TARBALL, see the e2e workflow), by rewriting the dependency to a file: path.
 */

export interface ExampleSpec {
  /** Directory under examples/. */
  name: string;
  /** Compose project name (the example's `name:`). */
  project: string;
  /** release.json image key -> { env var, Dockerfile }. */
  images: Record<string, { variable: string; file: string }>;
  /** Extra .env values (secrets the example leaves empty). */
  env?: Record<string, string>;
  /** More changes to the derived updater.yaml. */
  updater?: (config: Record<string, unknown>) => void;
  /** Files the operator creates in the project directory (path -> content). */
  files?: Record<string, string>;
}

export const SDK_TARBALL_NAME = "restow-backup-cicd-updater-1.0.0.tgz";
const SDK_URL = `https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/${SDK_TARBALL_NAME}`;

export class Example {
  readonly project: Project;
  readonly releases = new Map<string, Release>();

  private constructor(readonly spec: ExampleSpec) {
    this.project = new Project(spec.project);
  }

  get dir(): string {
    return this.project.dir;
  }

  static async create(spec: ExampleSpec): Promise<Example> {
    const example = new Example(spec);
    const dir = `${PROJECTS}/${spec.project}`;
    await sh(
      `rm -rf ${q(dir)} && mkdir -p ${q(dir)} && cp -R /repo/examples/${spec.name}/. ${q(dir)}/`,
    );
    if (spec.name === "node-postgres") {
      await example.useLocalSdk();
    }
    return example;
  }

  /**
   * node-postgres: install the SDK from the tarball of this repository (see above). The
   * lock entry gets the vendored tarball's integrity: pnpm pack on another OS or Node.js
   * major compresses differently (same files, other bytes).
   */
  private async useLocalSdk(): Promise<void> {
    const dir = this.dir;
    const vendored = `vendor/${SDK_TARBALL_NAME}`;
    await sh(
      `mkdir -p ${q(dir)}/app/vendor && cp ${WORK}/sdk/${SDK_TARBALL_NAME} ${q(dir)}/app/${vendored}`,
    );
    const integrity = `sha512-${(await sh(`openssl dgst -sha512 -binary ${q(dir)}/app/${vendored} | base64 -w0`)).stdout.trim()}`;
    const manifest = JSON.parse(await readFile(`${dir}/app/package.json`));
    if (manifest.dependencies["@restow-backup/cicd-updater"] !== SDK_URL) {
      throw new Error(`app/package.json does not install the SDK from ${SDK_URL}`);
    }
    manifest.dependencies["@restow-backup/cicd-updater"] = `file:${vendored}`;
    await writeFile(`${dir}/app/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    const lock = JSON.parse(await readFile(`${dir}/app/package-lock.json`));
    const entry = lock.packages["node_modules/@restow-backup/cicd-updater"];
    if (
      entry?.resolved !== SDK_URL ||
      lock.packages[""].dependencies["@restow-backup/cicd-updater"] !== SDK_URL
    ) {
      throw new Error(`app/package-lock.json does not resolve the SDK to ${SDK_URL}`);
    }
    lock.packages[""].dependencies["@restow-backup/cicd-updater"] = `file:${vendored}`;
    entry.resolved = `file:${vendored}`;
    entry.integrity = integrity;
    await writeFile(`${dir}/app/package-lock.json`, `${JSON.stringify(lock, null, 2)}\n`);
    for (const file of ["app/Dockerfile", "web/Dockerfile"]) {
      const text = await readFile(`${dir}/${file}`);
      const copy = "COPY app/package.json app/package-lock.json ./";
      if (!text.includes(copy)) {
        throw new Error(`${file} has no "${copy}"`);
      }
      await writeFile(`${dir}/${file}`, text.replace(copy, `${copy}\nCOPY app/vendor vendor`));
    }
  }

  /** Build, push, sign and publish one version of the example into its file feed. */
  async release(version: string): Promise<Release> {
    const images = Object.fromEntries(
      Object.entries(this.spec.images).map(([key, image]) => [
        key,
        {
          repository: `${REGISTRY}/examples/${this.spec.project}-${key}`,
          context: ".",
          file: image.file,
        },
      ]),
    );
    const release = await publishRelease({
      root: this.dir,
      feed: this.project.feed,
      version,
      images,
      project: `local/examples/${this.spec.project}`,
      signing: "key",
    });
    this.releases.set(version, release);
    return release;
  }

  ref(version: string, key: string): string {
    const image = this.releases.get(version)?.images[key];
    if (!image) {
      throw new Error(`no image ${key} in ${version}`);
    }
    return imageRef(image);
  }

  /** The example's updater.yaml with the file feed and the e2e key. */
  async updaterConfig(): Promise<Record<string, unknown>> {
    const config = parse(await readFile(`${this.dir}/updater.yaml`)) as Record<string, unknown>;
    config.release = {
      ...(config.release as object),
      feed: { type: "file", path: this.project.feed },
      cacheSeconds: 0,
    };
    config.trust = { mode: "key", key: { publicKeyFiles: [`${this.dir}/keys/cosign.pub`] } };
    config.docker = { ...((config.docker as object) ?? {}), minFreeMb: 64 };
    this.spec.updater?.(config);
    return config;
  }

  /** .env from .env.example as written, plus the project path, images and secrets. */
  async install(version: string): Promise<Project> {
    await sh(
      `mkdir -p ${q(this.dir)}/keys && cp ${KEYS}/main/cosign.pub ${q(this.dir)}/keys/cosign.pub`,
    );
    await writeFile(`${this.dir}/updater.yaml`, stringify(await this.updaterConfig()));
    for (const [file, content] of Object.entries(this.spec.files ?? {})) {
      await writeFile(`${this.dir}/${file}`, content, "600");
    }
    const example = await readFile(`${this.dir}/.env.example`);
    const values: Record<string, string> = {
      PROJECT_DIR: this.dir,
      CICD_UPDATER_IMAGE: UPDATER,
      ...Object.fromEntries(
        Object.entries(this.spec.images).map(([key, image]) => [
          image.variable,
          this.ref(version, key),
        ]),
      ),
      ...(this.spec.env ?? {}),
    };
    const lines = example.split("\n").map((line) => {
      const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
      const key = match?.[1];
      if (key && Object.hasOwn(values, key)) {
        const value = values[key] as string;
        delete values[key];
        return `${key}=${value}`;
      }
      return line;
    });
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${key}=${value}`);
    }
    await writeFile(`${this.dir}/.env`, lines.join("\n"), "600");
    await this.project.up();
    await this.project.ready();
    return this.project;
  }
}
