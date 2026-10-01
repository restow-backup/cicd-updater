import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type Logger,
  projectMatches,
  type Redactor,
  type SourceBuilder,
  SourceError,
  sourceImageRef,
} from "@cicd-updater/engine";
import { FeedHttp, type FetchLike, HostPolicy } from "@cicd-updater/feed";
import type { UpdaterConfig } from "@cicd-updater/protocol";
import { readTokenFile } from "./catalog.js";
import type { CliDocker } from "./docker.js";
import { extractTarGz } from "./safe-tar.js";

/**
 * Source mode (design 8.4): fetch the tag's archive of the configured feed
 * repository (never a repository from a request), extract it safely and build
 * each image key with `docker build`. Off unless `source.allowlist` names the
 * feed repository. The token travels as a header to the archive's origin only
 * and is dropped on a redirect to another origin; the tree is always removed.
 */

const MiB = 1024 * 1024;

/** Whether the allowlist names the feed project (`host` allows every repository on it). */
export function sourceAllowed(allowlist: readonly string[], project: string | null): boolean {
  if (!project) {
    return false;
  }
  const host = project.split("/")[0] ?? "";
  return allowlist.some((entry) => entry === host || projectMatches(entry, project));
}

export interface ArchiveSourceOptions {
  config: UpdaterConfig;
  stateDir: string;
  projectName: string;
  docker: CliDocker;
  redactor: Redactor;
  logger: Logger;
  /** The feed repository (`host/owner/repo`), null for static and file feeds. */
  project: string | null;
  /** The tag's archive URL, null when the feed has none. */
  archiveUrl: (tag: string) => string | null;
  /** Tests only. */
  fetch?: FetchLike;
  allowInsecureHttp?: boolean;
}

export class ArchiveSourceBuilder implements SourceBuilder {
  private readonly root: string;

  constructor(private readonly options: ArchiveSourceOptions) {
    this.root = path.join(options.stateDir, "src");
  }

  allowed(): boolean {
    return sourceAllowed(this.options.config.source.allowlist, this.options.project);
  }

  async purge(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }

  async build(input: Parameters<SourceBuilder["build"]>[0]): Promise<Record<string, string>> {
    const { config, docker, redactor } = this.options;
    if (!this.allowed()) {
      throw new SourceError(
        "source_not_allowed",
        "The feed repository is not in source.allowlist.",
      );
    }
    const url = this.options.archiveUrl(input.tag);
    if (!url) {
      throw new SourceError("source_not_allowed", "The feed has no source archives.");
    }
    let token: string | null;
    try {
      token = await readTokenFile(
        config.source.tokenFile ?? config.release.feed.tokenFile,
        redactor,
      );
    } catch (error) {
      throw new SourceError("token_unavailable", redactor.oneLine((error as Error).message, 300));
    }
    const workDir = path.join(this.root, input.runId);
    const archive = path.join(workDir, "source.tar.gz");
    const tree = path.join(workDir, "tree");
    try {
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
      await input.onStage("downloading", 0, input.imageKeys.length);
      const origin = new URL(url).origin;
      const http = new FeedHttp({
        policy: new HostPolicy(
          config.release.feed.allowPrivateNetwork ? [new URL(url).hostname] : [],
        ),
        token,
        tokenOrigin: origin,
        authScheme: config.release.feed.type === "gitea" ? "token" : "Bearer",
        fetch: this.options.fetch,
        allowInsecureHttp: this.options.allowInsecureHttp,
      });
      try {
        await http.download(url, archive, config.source.maxArchiveMb * MiB, 15 * 60_000);
      } catch (error) {
        throw new SourceError("download_failed", redactor.oneLine((error as Error).message, 500));
      }
      try {
        await extractTarGz(archive, tree, { maxBytes: config.source.maxArchiveMb * MiB * 8 });
      } catch (error) {
        throw new SourceError("download_failed", redactor.oneLine((error as Error).message, 500));
      }
      await fs.rm(archive, { force: true });
      const built: Record<string, string> = {};
      for (const [index, key] of input.imageKeys.entries()) {
        if (input.signal.aborted) {
          break;
        }
        const settings = config.source.build[key] ?? {
          context: ".",
          dockerfile: "Dockerfile",
          target: null,
          buildArgs: {},
        };
        const context = path.join(tree, settings.context);
        const dockerfile = path.join(context, settings.dockerfile);
        if (!context.startsWith(tree) || !dockerfile.startsWith(tree)) {
          throw new SourceError("build_failed", `The build paths of ${key} leave the source tree.`);
        }
        const stat = await fs.stat(dockerfile).catch(() => null);
        if (!stat?.isFile()) {
          throw new SourceError(
            "build_failed",
            `There is no ${settings.dockerfile} for the image ${key}.`,
          );
        }
        await input.onStage("building", index + 1, input.imageKeys.length);
        const tag = sourceImageRef(this.options.projectName, key, input.version);
        const buildArgs: Record<string, string> = {};
        for (const [name, value] of Object.entries(settings.buildArgs)) {
          buildArgs[name] = value.split("{version}").join(input.version);
        }
        try {
          await docker.build({
            contextDir: context,
            dockerfile,
            target: settings.target,
            tag,
            buildArgs,
          });
        } catch (error) {
          throw new SourceError(
            "build_failed",
            redactor.oneLine(
              (error as Error).message +
                ((error as { detail?: string }).detail
                  ? ` ${(error as { detail?: string }).detail}`
                  : ""),
              1000,
            ),
          );
        }
        built[key] = tag;
      }
      return built;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch((error: Error) => {
        this.options.logger.warn(`Could not remove the source tree: ${error.message}`);
      });
    }
  }
}
