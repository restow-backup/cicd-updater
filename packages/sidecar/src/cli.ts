import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { BackupStore, EnvFile, parseState, Redactor } from "@cicd-updater/engine";
import {
  API_VERSION,
  type BackupInfo,
  DEFAULT_CONFIG_PATH,
  describeCode,
  en,
  formatMessage,
  type ReleasesView,
  type Run,
  type StateView,
  type UpdaterConfig,
  type VerificationResult,
  writableKeys,
} from "@cicd-updater/protocol";
import { OPERATOR_TOKEN, TOKEN_FILE_NAME } from "./auth.js";
import { configView, formatProblems, loadConfig } from "./config-file.js";
import { CliDocker } from "./docker.js";
import { runDoctor } from "./doctor.js";
import { consoleIo, type Io, projectNameOf, serve, splitListen } from "./main.js";
import { maintenanceFiles } from "./maintenance.js";
import { inspectSelf } from "./preflight.js";
import { LocalRunner } from "./runner.js";
import { CLIENT_HEADER } from "./server.js";
import { SIDECAR_VERSION } from "./version.js";

/**
 * The `cicd-updater` command line (design appendix A). Commands that talk to
 * the running sidecar use its API on 127.0.0.1 with the token file. Exit codes:
 * 0 success, 1 refused or failed, 2 usage error, 3 sidecar unreachable or
 * unauthorized, 64 invalid configuration, 75 state directory locked.
 */

export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3, config: 64, locked: 75 } as const;

export const USAGE = `Usage: cicd-updater <command> [flags]

  serve                              run the sidecar (default)
  version                            sidecar, API and bundled tool versions
  config check [--file F]            validate offline, print the effective configuration and its hash
  doctor                             check every prerequisite, read-only
  healthcheck                        exit 0 when the running sidecar answers /healthz (image HEALTHCHECK)
  status                             phase, run, progress, outcome, running version
  releases [--refresh]               newer releases with refusals
  verify <version>                   dry-run verification (no pull)
  schedule <version> [--in 15m | --at <RFC3339>] [--source] [--yes] [--label TEXT]
  reschedule (--in 15m | --at <RFC3339>)
  cancel                             cancel the scheduled run or abort before the point of no return
  ack                                acknowledge the finished run
  logs [<runId>]                     redacted run log
  backups list | backups cat <file>  list backups, stream one to stdout
  recover show [<runId>]             recovery facts and commands of a needs_attention run
  recover restore-env <runId> [--yes] write the captured previous lines of the writable keys back
  maintenance-page export --out <dir> static maintenance page for edges that serve files
  release <subcommand>               release-side tools for any CI (cicd-updater release --help)

Global flags: --json (machine-readable output), --help`;

export class UsageError extends Error {}

/** `15m`, `90s`, `2h`, `1d`, `300` -> seconds. */
export function parseDuration(text: string): number {
  const match = /^(\d{1,7})([smhd]?)$/.exec(text.trim());
  if (!match) {
    throw new UsageError(`${text} is not a duration (examples: 90s, 15m, 2h, 1d).`);
  }
  const factor = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "" | "s" | "m" | "h" | "d"];
  return Number(match[1]) * factor;
}

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  io: Io;
  fetch: typeof fetch;
  /** Ask a yes/no question (null: not interactive). */
  confirm: ((question: string) => Promise<boolean>) | null;
  stdout: NodeJS.WritableStream;
  /** The release-tools CLI (bundled in the image). */
  release?: (args: string[], io: Io) => Promise<number>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown> | null,
  ) {
    super(typeof body?.detail === "string" ? body.detail : `HTTP ${status}`);
  }
}

class Unreachable extends Error {}

async function localClient(config: UpdaterConfig, deps: CliDeps) {
  const tokenFile = config.auth.tokenFile ?? path.join(config.auth.sharedDir, TOKEN_FILE_NAME);
  let token: string;
  try {
    token = (await fs.readFile(tokenFile, "utf8")).trim();
  } catch {
    throw new Unreachable(`The token file ${tokenFile} cannot be read (is the sidecar running?).`);
  }
  if (!OPERATOR_TOKEN.test(token)) {
    throw new Unreachable(`The token file ${tokenFile} holds no token.`);
  }
  const [host, port] = splitListen(config.server.listen);
  const base = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${port}`;
  return async <T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    let response: Response;
    try {
      response = await deps.fetch(`${base}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          [CLIENT_HEADER]: "cli",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(method === "GET" ? 30_000 : 600_000),
      });
    } catch (error) {
      throw new Unreachable(`The sidecar does not answer on ${base}: ${(error as Error).message}`);
    }
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (response.status === 401) {
      throw new Unreachable("The sidecar refused the token.");
    }
    if (!response.ok) {
      throw new ApiError(response.status, parsed as Record<string, unknown> | null);
    }
    return { status: response.status, body: parsed as T };
  };
}

function describeRun(run: Run, io: Io): void {
  io.out(
    `Run ${run.id}: ${run.fromVersion ?? "?"} -> ${run.targetVersion} (${run.mode}, trust ${run.trustMode})`,
  );
  io.out(
    `  starts at ${run.startsAt}${run.startedAt ? `, started ${run.startedAt}` : ""}${run.finishedAt ? `, finished ${run.finishedAt}` : ""}`,
  );
  io.out(
    `  progress ${run.progress} %, step ${run.step ?? "-"}${run.outcome ? `, outcome ${run.outcome}` : ""}`,
  );
  if (run.message) {
    io.out(`  ${formatMessage(en, run.message)}`);
  }
  if (run.failure) {
    io.out(`  failure ${run.failure.code}: ${describeCode(en, "failures", run.failure.code)}`);
    if (run.failure.detail) {
      io.out(`  detail: ${run.failure.detail}`);
    }
  }
  io.out(
    `  verification: signatures ${run.verification.signatures ?? "-"}, digests ${run.verification.digests ?? "-"}`,
  );
}

function printProblem(error: ApiError, io: Io): number {
  const body = error.body ?? {};
  io.err(`refused (${String(body.code ?? error.status)}): ${error.message}`);
  for (const key of ["blockers", "reasons", "errors"] as const) {
    const list = body[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        io.err(
          `  - ${typeof item === "string" ? `${item}: ${describeCode(en, "refusals", item)}` : JSON.stringify(item)}`,
        );
      }
    }
  }
  return EXIT.failed;
}

export async function runCli(
  argv: readonly string[],
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  const { io } = deps;
  const [command = "serve", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return EXIT.ok;
  }
  if (command === "serve") {
    return await serve(deps.env, io);
  }
  if (command === "release") {
    if (!deps.release) {
      io.err("The release tools are not available in this build.");
      return EXIT.usage;
    }
    return await deps.release(rest, io);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        refresh: { type: "boolean", default: false },
        file: { type: "string" },
        in: { type: "string" },
        at: { type: "string" },
        source: { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        label: { type: "string" },
        out: { type: "string" },
        "status-url": { type: "string" },
        "home-url": { type: "string" },
        "asset-base": { type: "string" },
      },
    });
  } catch (error) {
    io.err((error as Error).message);
    io.err(USAGE);
    return EXIT.usage;
  }
  const flags = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;
  const json = flags.json === true;
  const print = (value: unknown): void => io.out(JSON.stringify(value, null, 2));

  if (command === "version") {
    const runner = new LocalRunner({ redactor: new Redactor(), cwd: "/" });
    const tool = async (argv: [string, ...string[]], whole = false): Promise<string> => {
      const result = await runner.run({ argv: argv as never, timeoutMs: 10_000 }).catch(() => null);
      if (result?.exitCode !== 0) {
        return "not available";
      }
      const text = result.stdout.trim();
      return whole ? text : (text.split("\n")[0] ?? "");
    };
    const versions = {
      cicdUpdater: SIDECAR_VERSION,
      api: API_VERSION,
      node: process.versions.node,
      docker: await tool(["docker", "version", "--format", "{{.Client.Version}}"]),
      compose: await tool(["docker", "compose", "version", "--short"]),
      buildx: await tool(["docker", "buildx", "version"]),
      cosign: await (async () => {
        const text = await tool(["cosign", "version", "--json"], true);
        try {
          const parsedVersion = (JSON.parse(text) as { gitVersion?: unknown }).gitVersion;
          return typeof parsedVersion === "string" ? parsedVersion : text;
        } catch {
          return text;
        }
      })(),
      age: await tool(["age", "--version"]),
    };
    if (json) {
      print(versions);
    } else {
      for (const [name, value] of Object.entries(versions)) {
        io.out(`${name.padEnd(12)} ${value}`);
      }
    }
    return EXIT.ok;
  }

  const configFile =
    typeof flags.file === "string"
      ? flags.file
      : deps.env.CICD_UPDATER_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  const loaded = await loadConfig(deps.env, configFile);

  if (command === "config") {
    if (positionals[0] !== "check") {
      io.err("Usage: cicd-updater config check [--file F]");
      return EXIT.usage;
    }
    if (!loaded.ok) {
      if (json) {
        print({ ok: false, file: loaded.file, problems: loaded.problems });
      } else {
        io.err(formatProblems(loaded.file, loaded.problems));
      }
      return EXIT.config;
    }
    const view = configView(loaded.config, (text) => new Redactor().redact(text));
    if (json) {
      print({
        ok: true,
        file: loaded.file,
        configHash: loaded.configHash,
        overrides: loaded.overrides,
        config: view,
      });
    } else {
      io.out(`${loaded.file}: valid`);
      io.out(`configHash ${loaded.configHash}`);
      if (loaded.overrides.length > 0) {
        io.out(`environment overrides: ${loaded.overrides.join(", ")}`);
      }
      io.out(JSON.stringify(view, null, 2));
    }
    return EXIT.ok;
  }

  if (!loaded.ok) {
    io.err(formatProblems(loaded.file, loaded.problems));
    return EXIT.config;
  }
  const config = loaded.config;

  if (command === "healthcheck") {
    // The image's HEALTHCHECK: the liveness endpoint on the configured listen address.
    const [host, port] = splitListen(config.server.listen);
    const base = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host}:${port}`;
    try {
      const response = await deps.fetch(`${base}/healthz`, {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
      });
      return response.ok ? EXIT.ok : EXIT.failed;
    } catch {
      return EXIT.unreachable;
    }
  }

  if (command === "doctor") {
    const redactor = new Redactor(config.logging.redactPatterns);
    // The registry check reads manifests with the operator's credentials, as pulls do.
    let dockerConfig: string | null = null;
    if (config.docker.registryAuthFile) {
      dockerConfig = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-doctor-"));
      await fs.symlink(config.docker.registryAuthFile, path.join(dockerConfig, "config.json"));
    }
    const runner = new LocalRunner({
      redactor,
      cwd: config.compose.projectDir,
      fixedEnv: {
        DOCKER_HOST: `unix://${config.docker.socket}`,
        ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}),
      },
    });
    const timeouts = {
      pullSeconds: 60,
      upSeconds: 60,
      composeSeconds: config.timeouts.composeSeconds,
      stopSeconds: 10,
    };
    const probe = new CliDocker({
      runner,
      redactor,
      compose: {
        projectName: config.compose.projectName ?? "probe",
        files: [],
        envFile: null,
        profiles: [],
      },
      timeouts,
    });
    const self = await inspectSelf(probe, config.trust.verifier.workDir).catch(() => null);
    const docker = new CliDocker({
      runner,
      redactor,
      compose: {
        projectName: projectNameOf(config, self),
        files: config.compose.files,
        envFile: config.compose.envFile === ".env" ? null : config.compose.envFile,
        profiles: config.compose.profiles,
      },
      timeouts,
    });
    const report = await runDoctor({ loaded, docker, self, redactor, fetch: deps.fetch }).finally(
      () => (dockerConfig ? fs.rm(dockerConfig, { recursive: true, force: true }) : undefined),
    );
    if (json) {
      print(report);
    } else {
      for (const check of report.checks) {
        io.out(
          `${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}${check.where ? `  [${check.where}]` : ""}`,
        );
      }
    }
    return report.exitCode;
  }

  if (command === "backups" && positionals[0] === "cat") {
    const name = positionals[1];
    if (!name) {
      io.err("Usage: cicd-updater backups cat <file>");
      return EXIT.usage;
    }
    const project = (await projectFromState(config)) ?? projectNameOf(config, null);
    const scoped = new BackupStore(path.join(config.state.dir, "backups"), project);
    let file: string;
    try {
      file = scoped.pathOf(name);
    } catch {
      io.err(`${name} is not a backup of this sidecar.`);
      return EXIT.failed;
    }
    try {
      await pipeline(createReadStream(file), deps.stdout, { end: false });
    } catch (error) {
      io.err(`Cannot read ${name}: ${(error as Error).message}`);
      return EXIT.failed;
    }
    return EXIT.ok;
  }

  if (command === "recover" && positionals[0] === "restore-env") {
    return await restoreEnv(config, positionals[1], flags.yes === true, deps);
  }

  if (command === "maintenance-page") {
    if (positionals[0] !== "export" || typeof flags.out !== "string") {
      io.err(
        "Usage: cicd-updater maintenance-page export --out <dir> [--status-url URL] [--home-url URL] [--asset-base URL]",
      );
      return EXIT.usage;
    }
    const files = await maintenanceFiles(config, {
      statusUrl:
        typeof flags["status-url"] === "string" ? flags["status-url"] : "/public/v1/status",
      homeUrl: typeof flags["home-url"] === "string" ? flags["home-url"] : "/",
      // Exported files are served by the edge itself, by default next to each other.
      assetBase: typeof flags["asset-base"] === "string" ? flags["asset-base"] : "",
    });
    await fs.mkdir(flags.out, { recursive: true });
    for (const [name, file] of Object.entries(files)) {
      await fs.writeFile(path.join(flags.out, name), file.body);
    }
    io.out(`Wrote ${Object.keys(files).join(", ")} to ${flags.out}.`);
    return EXIT.ok;
  }

  // Everything below talks to the running sidecar.
  let call: Awaited<ReturnType<typeof localClient>>;
  try {
    call = await localClient(config, deps);
  } catch (error) {
    io.err((error as Error).message);
    return EXIT.unreachable;
  }
  try {
    return await apiCommand(command, positionals, flags, call, deps);
  } catch (error) {
    if (error instanceof Unreachable) {
      io.err(error.message);
      return EXIT.unreachable;
    }
    if (error instanceof ApiError) {
      if (json) {
        print(error.body);
        return EXIT.failed;
      }
      return printProblem(error, io);
    }
    if (error instanceof UsageError) {
      io.err(error.message);
      return EXIT.usage;
    }
    throw error;
  }
}

async function projectFromState(config: UpdaterConfig): Promise<string | null> {
  // Backups are named after the project; read the name the sidecar uses from its status.
  try {
    const names = await fs.readdir(path.join(config.state.dir, "backups"));
    const match = names
      .map((name) => /^([a-z0-9][a-z0-9_-]{0,62})-\d{8}-\d{6}Z-/.exec(name)?.[1])
      .find(Boolean);
    return match ?? config.compose.projectName;
  } catch {
    return config.compose.projectName;
  }
}

async function restoreEnv(
  config: UpdaterConfig,
  runId: string | undefined,
  yes: boolean,
  deps: CliDeps,
): Promise<number> {
  const { io } = deps;
  if (!runId) {
    io.err("Usage: cicd-updater recover restore-env <runId> [--yes]");
    return EXIT.usage;
  }
  const raw = await fs
    .readFile(path.join(config.state.dir, "status.json"), "utf8")
    .catch(() => null);
  const state = raw ? parseState(raw) : null;
  if (!state?.ok) {
    io.err("status.json cannot be read.");
    return EXIT.failed;
  }
  const run =
    state.state.run?.id === runId
      ? state.state.run
      : state.state.history.find((entry) => entry.id === runId);
  const previous =
    run?.recovery?.previousEnv ??
    (state.state.run?.id === runId ? state.state.runContext?.previousEnv : null);
  if (!run || !previous || Object.keys(previous).length === 0) {
    io.err(`Run ${runId} has no captured env lines.`);
    return EXIT.failed;
  }
  const keys = writableKeys(config);
  const restore = Object.fromEntries(
    Object.entries(previous).filter(([key]) => keys.includes(key)),
  );
  for (const [key, captured] of Object.entries(restore)) {
    io.out(captured.present ? `restore: ${captured.line}` : `remove:  ${key}`);
  }
  if (!yes) {
    if (!deps.confirm || !(await deps.confirm("Write these lines to the env file?"))) {
      io.err("Nothing was written (use --yes to skip the question).");
      return EXIT.failed;
    }
  }
  const envFile = new EnvFile(path.join(config.compose.projectDir, config.compose.envFile), keys);
  await envFile.restore(restore);
  io.out(`Restored ${Object.keys(restore).join(", ")} in ${envFile.filePath}.`);
  return EXIT.ok;
}

async function apiCommand(
  command: string,
  positionals: string[],
  flags: Record<string, string | boolean | undefined>,
  call: Awaited<ReturnType<typeof localClient>>,
  deps: CliDeps,
): Promise<number> {
  const { io } = deps;
  const json = flags.json === true;
  const print = (value: unknown): void => io.out(JSON.stringify(value, null, 2));
  const state = async (): Promise<StateView> => (await call<StateView>("GET", "/v1/state")).body;
  const when = (): { leadSeconds: number } | { startsAt: string } | null => {
    if (typeof flags.in === "string" && typeof flags.at === "string") {
      throw new UsageError("Use either --in or --at.");
    }
    if (typeof flags.at === "string") {
      if (Number.isNaN(Date.parse(flags.at))) {
        throw new UsageError(`${flags.at} is not an RFC 3339 time.`);
      }
      return { startsAt: new Date(flags.at).toISOString() };
    }
    if (typeof flags.in === "string") {
      return { leadSeconds: parseDuration(flags.in) };
    }
    return null;
  };

  switch (command) {
    case "status": {
      const view = await state();
      if (json) {
        print(view);
        return EXIT.ok;
      }
      io.out(`phase: ${view.phase} (${en.phases[view.phase]})`);
      io.out(
        `running: ${view.running.version ?? "unknown"}${view.running.source ? ` (from ${view.running.source})` : ""}`,
      );
      io.out(`trust: ${view.trust.mode}${view.trust.identity ? ` ${view.trust.identity}` : ""}`);
      io.out(`ready: ${view.capabilities.ready ? "yes" : "no"}`);
      for (const blocker of view.capabilities.blockers) {
        io.out(
          `  blocker ${blocker.code}: ${describeCode(en, "blockers", blocker.code)}${blocker.detail ? ` (${blocker.detail})` : ""}`,
        );
      }
      for (const warning of view.capabilities.warnings) {
        io.out(`  warning ${warning.code}: ${describeCode(en, "warnings", warning.code)}`);
      }
      if (view.run) {
        describeRun(view.run, io);
      }
      return EXIT.ok;
    }
    case "releases": {
      const view = (
        await call<ReleasesView>("GET", `/v1/releases${flags.refresh ? "?refresh=true" : ""}`)
      ).body;
      if (json) {
        print(view);
        return EXIT.ok;
      }
      io.out(
        `channel ${view.channel}, running ${view.running ?? "unknown"}, next installable ${view.nextInstallable ?? "-"}`,
      );
      for (const release of view.releases) {
        io.out(
          `  ${release.version.padEnd(16)} ${release.refusals.length ? `refused: ${release.refusals.join(", ")}` : "installable"}`,
        );
      }
      return EXIT.ok;
    }
    case "verify": {
      const version = positionals[0];
      if (!version) {
        throw new UsageError("Usage: cicd-updater verify <version>");
      }
      const result = (
        await call<VerificationResult>(
          "POST",
          `/v1/releases/${encodeURIComponent(version)}/verification`,
        )
      ).body;
      if (json) {
        print(result);
      } else {
        io.out(`release.json ${result.release.document}, sha256 ${result.release.sha256 ?? "-"}`);
        for (const image of result.images) {
          io.out(
            `  ${image.key}: ${image.ref} signature ${image.signature}, exists ${String(image.exists)}${image.error ? `, ${image.error}` : ""}`,
          );
        }
        io.out(result.refusals.length ? `refused: ${result.refusals.join(", ")}` : "installable");
      }
      return result.refusals.length === 0 &&
        result.images.every((image) => image.signature !== "failed" && image.exists !== false)
        ? EXIT.ok
        : EXIT.failed;
    }
    case "schedule": {
      const version = positionals[0];
      if (!version) {
        throw new UsageError(
          "Usage: cicd-updater schedule <version> [--in 15m | --at <RFC3339>] [--source] [--yes]",
        );
      }
      const start = when() ?? { leadSeconds: 0 };
      if (flags.yes !== true) {
        const question = `Schedule the update to ${version}${"startsAt" in start ? ` at ${start.startsAt}` : start.leadSeconds ? ` in ${start.leadSeconds} s` : " now"}${flags.source ? " (building from source)" : ""}?`;
        if (!deps.confirm || !(await deps.confirm(question))) {
          io.err("Nothing was scheduled (use --yes to skip the question).");
          return EXIT.failed;
        }
      }
      const body = {
        version,
        mode: flags.source ? "source" : "image",
        ...start,
        requestedBy: { id: null, label: typeof flags.label === "string" ? flags.label : "cli" },
      };
      const view = (await call<StateView>("POST", "/v1/runs", body)).body;
      if (json) {
        print(view);
      } else if (view.run) {
        describeRun(view.run, io);
      }
      return EXIT.ok;
    }
    case "reschedule": {
      const start = when();
      if (!start) {
        throw new UsageError("Usage: cicd-updater reschedule (--in 15m | --at <RFC3339>)");
      }
      const current = await state();
      if (!current.run) {
        io.err("Nothing is scheduled.");
        return EXIT.failed;
      }
      const view = (await call<StateView>("PATCH", `/v1/runs/${current.run.id}`, start)).body;
      if (json) {
        print(view);
      } else if (view.run) {
        describeRun(view.run, io);
      }
      return EXIT.ok;
    }
    case "cancel":
    case "ack": {
      const current = await state();
      if (!current.run) {
        io.err("There is no current run.");
        return EXIT.failed;
      }
      const action = command === "cancel" ? "cancel" : "acknowledge";
      const response = await call<StateView>("POST", `/v1/runs/${current.run.id}/${action}`);
      if (json) {
        print(response.body);
      } else {
        io.out(
          action === "acknowledge"
            ? `Run ${current.run.id} acknowledged.`
            : response.status === 202
              ? `Abort of run ${current.run.id} requested; it stops at its next check point.`
              : `Run ${current.run.id} cancelled.`,
        );
      }
      return EXIT.ok;
    }
    case "logs": {
      const runId = positionals[0] ?? (await state()).run?.id;
      if (!runId) {
        io.err("There is no current run; name one: cicd-updater logs <runId>.");
        return EXIT.failed;
      }
      const run = (await call<Run>("GET", `/v1/runs/${encodeURIComponent(runId)}`)).body;
      if (json) {
        print(run.log);
      } else {
        for (const line of run.log) {
          io.out(line);
        }
      }
      return EXIT.ok;
    }
    case "backups": {
      if (positionals[0] !== "list") {
        throw new UsageError("Usage: cicd-updater backups list | backups cat <file>");
      }
      const list = (await call<{ backups: BackupInfo[] }>("GET", "/v1/backups")).body.backups;
      if (json) {
        print(list);
      } else {
        for (const backup of list) {
          io.out(
            `${backup.file}  ${backup.bytes} bytes  ${backup.verified ? "verified" : "unverified"}${backup.encrypted ? "  encrypted" : ""}${backup.protected ? "  protected" : ""}`,
          );
        }
      }
      return EXIT.ok;
    }
    case "recover": {
      if (positionals[0] !== "show") {
        throw new UsageError(
          "Usage: cicd-updater recover show [<runId>] | recover restore-env <runId>",
        );
      }
      const runId = positionals[1] ?? (await state()).run?.id;
      if (!runId) {
        io.err("There is no current run.");
        return EXIT.failed;
      }
      const run = (await call<Run>("GET", `/v1/runs/${encodeURIComponent(runId)}`)).body;
      if (!run.recovery) {
        io.err(`Run ${runId} has no recovery information (outcome ${run.outcome ?? "-"}).`);
        return EXIT.failed;
      }
      if (json) {
        print(run.recovery);
      } else {
        io.out(
          `Run ${run.id}: ${run.outcome}, failure ${run.failure?.code ?? "-"}, schema changed: ${String(run.failure?.schemaChanged ?? "unknown")}`,
        );
        io.out(`from version: ${run.recovery.fromVersion ?? "unknown"}`);
        io.out(
          `backup: ${run.recovery.backup ? `${run.recovery.backup.file} (${run.recovery.backup.bytes} bytes, sha256 ${run.recovery.backup.sha256})` : "none"}`,
        );
        for (const [service, image] of Object.entries(run.recovery.previousImages)) {
          io.out(`previous image of ${service}: ${image ?? "unknown"}`);
        }
        io.out("Commands (review before running them on the host):");
        for (const line of run.recovery.commands) {
          io.out(`  ${line}`);
        }
      }
      return EXIT.ok;
    }
    default:
      io.err(`Unknown command ${command}.`);
      io.err(USAGE);
      return EXIT.usage;
  }
}

function defaultDeps(): CliDeps {
  return {
    env: process.env,
    io: consoleIo,
    fetch,
    stdout: process.stdout,
    confirm: process.stdin.isTTY
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : null,
  };
}
