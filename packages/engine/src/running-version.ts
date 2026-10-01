import { normalizeVersion, startGroups, type UpdaterConfig } from "@cicd-updater/protocol";
import type { EnvFile } from "./env-file.js";
import { envValueOf } from "./env-file.js";
import type { Clock, DockerOps, Hooks } from "./ports.js";
import type { StatusStore } from "./store.js";

export type RunningSource = "health" | "label" | "state" | "env";

export interface RunningVersion {
  version: string | null;
  source: RunningSource | null;
}

export const OCI_VERSION_LABEL = "org.opencontainers.image.version";
const CACHE_MS = 30_000;

/**
 * The version that runs now (design 5.12), from the first source that yields a
 * valid version: the app's health check, the OCI version label of the image of
 * the first managed service in the lowest group, the last succeeded run (if
 * the containers still use the images it installed), the `env.versionVar` value
 * (lowest trust: it can outlive a failed update).
 */
export class RunningVersionResolver {
  private cached: { at: number; value: RunningVersion } | null = null;

  constructor(
    private readonly deps: {
      config: Pick<UpdaterConfig, "services" | "env">;
      hooks: Hooks;
      ops: DockerOps;
      store: StatusStore;
      envFile: EnvFile;
      clock: Clock;
    },
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  async detect(fresh = false): Promise<RunningVersion> {
    const now = this.deps.clock.now().getTime();
    if (!fresh && this.cached && now - this.cached.at < CACHE_MS) {
      return this.cached.value;
    }
    const value = await this.compute();
    this.cached = { at: this.deps.clock.now().getTime(), value };
    return value;
  }

  private async compute(): Promise<RunningVersion> {
    const { hooks, ops, store, envFile, config } = this.deps;
    if (hooks.appReportsVersion) {
      try {
        const result = await hooks.appCheck();
        const version = result?.healthy && result.version ? normalizeVersion(result.version) : null;
        if (version) {
          return { version, source: "health" };
        }
      } catch {
        // Fall through to the next source.
      }
    }
    const first = startGroups(config)[0]?.services[0];
    if (first) {
      try {
        const label = await ops.runningImageLabel(first.name, OCI_VERSION_LABEL);
        const version = label ? normalizeVersion(label) : null;
        if (version) {
          return { version, source: "label" };
        }
      } catch {
        // Fall through.
      }
    }
    const lastSucceeded = store.state.history.find((run) => run.outcome === "succeeded");
    if (lastSucceeded && Object.keys(lastSucceeded.images).length > 0) {
      try {
        const states = await ops.serviceStates();
        const matches = Object.entries(lastSucceeded.images).every(([service, image]) =>
          states.some((state) => state.service === service && state.image === image),
        );
        if (matches) {
          return { version: lastSucceeded.targetVersion, source: "state" };
        }
      } catch {
        // Fall through.
      }
    }
    if (config.env.versionVar) {
      try {
        const value = envValueOf(await envFile.read(), config.env.versionVar);
        const version = value ? normalizeVersion(value) : null;
        if (version) {
          return { version, source: "env" };
        }
      } catch {
        // Unknown.
      }
    }
    return { version: null, source: null };
  }
}
