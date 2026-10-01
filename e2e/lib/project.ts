import { stringify } from "yaml";
import { q, type Result, sleep, waitFor } from "./exec.js";
import { PROJECTS, readFile, type ShOptions, sh, writeFile } from "./host.js";

/**
 * One Compose project inside the host with the sidecar as a Compose service (profile
 * `updater`, labelled, the project directory mounted at the same path), driven through
 * the sidecar's own CLI (`docker compose exec updater cicd-updater ...`).
 */

export interface RunView {
  id: string;
  outcome: string | null;
  targetVersion: string;
  fromVersion: string | null;
  failure: {
    code: string;
    step: string | null;
    detail: string;
    schemaChanged: boolean | null;
  } | null;
  recovery: {
    backup: { file: string } | null;
    commands: string[];
    previousImages: Record<string, string | null>;
  } | null;
  verification: { signatures: string | null; digests: string | null };
  trustMode: string;
  steps: { id: string; status: string; detail: Record<string, unknown> }[];
  images: Record<string, string>;
  abortRequestedAt: string | null;
  cancelled: boolean;
  log?: string[];
  startsAt: string;
  release: { sha256: string | null; document: string };
}

export interface StateView {
  phase: string;
  run: RunView | null;
  history: RunView[];
  running: { version: string | null; source: string };
  trust: { mode: string };
  capabilities: {
    ready: boolean;
    blockers: { code: string; detail: string }[];
    warnings: { code: string; detail: string }[];
  };
}

export interface ProjectSpec {
  name: string;
  compose: Record<string, unknown>;
  updater: Record<string, unknown>;
  env: Record<string, string>;
  files?: Record<string, string>;
}

export class Project {
  readonly dir: string;
  readonly feed: string;

  constructor(readonly name: string) {
    this.dir = `${PROJECTS}/${name}`;
    this.feed = `${this.dir}/feed`;
  }

  static async create(spec: ProjectSpec): Promise<Project> {
    const project = new Project(spec.name);
    await sh(`rm -rf ${q(project.dir)} && mkdir -p ${q(project.feed)}`);
    await project.writeCompose(spec.compose);
    await project.writeUpdater(spec.updater);
    await project.writeEnv(spec.env);
    for (const [file, content] of Object.entries(spec.files ?? {})) {
      await writeFile(`${project.dir}/${file}`, content);
    }
    return project;
  }

  async writeCompose(compose: Record<string, unknown>): Promise<void> {
    await writeFile(`${this.dir}/docker-compose.yml`, stringify({ name: this.name, ...compose }));
  }

  /** The updater.yaml last written (reconfigure starts from it). */
  config: Record<string, unknown> = {};

  async writeUpdater(updater: Record<string, unknown>): Promise<void> {
    this.config = structuredClone(updater);
    await writeFile(`${this.dir}/updater.yaml`, stringify(updater));
  }

  /** Change updater.yaml and restart the sidecar with it. */
  async reconfigure(change: (config: Record<string, unknown>) => void): Promise<StateView> {
    const config = structuredClone(this.config);
    change(config);
    await this.writeUpdater(config);
    await this.compose(["restart", "-t", "30", "updater"]);
    return this.ready();
  }

  /**
   * An HTTP request from inside a service container (node's fetch), as the app makes it;
   * the token goes in the Authorization header.
   */
  async http(
    service: string,
    url: string,
    token?: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: string }> {
    const script = `
const headers = { "content-type": "application/json" };
if (process.env.E2E_TOKEN) headers.authorization = "Bearer " + process.env.E2E_TOKEN;
const response = await fetch(process.env.E2E_URL, {
  method: process.env.E2E_METHOD || "GET",
  headers,
  body: process.env.E2E_BODY || undefined,
});
process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
`;
    const result = await this.compose(
      [
        "exec",
        "-T",
        "-e",
        "E2E_URL",
        "-e",
        "E2E_TOKEN",
        "-e",
        "E2E_METHOD",
        "-e",
        "E2E_BODY",
        service,
        "node",
        "--input-type=module",
        "-e",
        script,
      ],
      {
        shellEnv: {
          E2E_URL: url,
          E2E_TOKEN: token ?? "",
          E2E_METHOD: init.method ?? "GET",
          E2E_BODY: init.body === undefined ? "" : JSON.stringify(init.body),
        },
      },
    );
    return JSON.parse(result.stdout) as { status: number; body: string };
  }

  async writeEnv(env: Record<string, string>): Promise<void> {
    const text = Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    await writeFile(`${this.dir}/.env`, `${text}\n`, "600");
  }

  /** `docker compose --profile updater <args>` in the project directory. */
  compose(args: readonly string[], options: ShOptions = {}): Promise<Result> {
    return sh(`cd ${q(this.dir)} && docker compose --profile updater ${args.map(q).join(" ")}`, {
      timeoutMs: 600_000,
      ...options,
    });
  }

  async up(services: string[] = []): Promise<void> {
    await this.compose(["up", "-d", "--wait", "--wait-timeout", "180", ...services]);
  }

  async down(): Promise<void> {
    if (process.env.E2E_KEEP_PROJECTS === "1") {
      return;
    }
    await this.compose(["down", "-v", "--remove-orphans", "--timeout", "5"], { allowFail: true });
    await sh(
      `docker ps -aq --filter label=io.github.restow-backup.cicd-updater.managed=true | xargs -r docker rm -f > /dev/null; rm -rf ${q(this.dir)}`,
      { allowFail: true },
    );
  }

  /** `cicd-updater <args>` in the running sidecar. */
  cli(args: readonly string[], options: ShOptions = {}): Promise<Result> {
    return this.compose(["exec", "-T", "updater", "cicd-updater", ...args], options);
  }

  async state(): Promise<StateView> {
    return JSON.parse((await this.cli(["status", "--json"])).stdout) as StateView;
  }

  /** Wait until the sidecar answers (after up or a restart). */
  async ready(): Promise<StateView> {
    return waitFor(
      "the sidecar",
      async () => {
        const result = await this.cli(["status", "--json"], { allowFail: true });
        return result.code === 0 ? (JSON.parse(result.stdout) as StateView) : undefined;
      },
      { timeoutMs: 90_000 },
    );
  }

  /** Schedule an update; returns the CLI result (exit 1 with the problem when refused). */
  schedule(version: string, extra: string[] = ["--in", "0"]): Promise<Result> {
    return this.cli(["schedule", version, ...extra, "--yes", "--json", "--label", "e2e"], {
      allowFail: true,
      timeoutMs: 600_000,
    });
  }

  /** Schedule now and wait for the outcome. */
  async update(version: string, timeoutMs = 420_000): Promise<RunView> {
    const scheduled = await this.schedule(version);
    if (scheduled.code !== 0) {
      throw new Error(`schedule ${version} refused:\n${scheduled.stdout}\n${scheduled.stderr}`);
    }
    return this.finished(timeoutMs);
  }

  /** Wait for the current run to finish; returns it with its log. */
  async finished(timeoutMs = 420_000): Promise<RunView> {
    const state = await waitFor(
      "the run to finish",
      async () => {
        const result = await this.cli(["status", "--json"], { allowFail: true });
        if (result.code !== 0) {
          return undefined;
        }
        const view = JSON.parse(result.stdout) as StateView;
        return view.phase === "succeeded" || view.phase === "failed" ? view : undefined;
      },
      { timeoutMs, intervalMs: 2000 },
    );
    const run = state.run as RunView;
    const logs = await this.cli(["logs", run.id, "--json"], { allowFail: true });
    if (logs.code === 0) {
      run.log = JSON.parse(logs.stdout) as string[];
    }
    return run;
  }

  /** Wait for a phase (and optionally a step) of the current run. */
  async waitFor(phase: string, step?: string, timeoutMs = 300_000): Promise<StateView> {
    return waitFor(
      `phase ${phase}${step ? ` step ${step}` : ""}`,
      async () => {
        const result = await this.cli(["status", "--json"], { allowFail: true });
        if (result.code !== 0) {
          return undefined;
        }
        const view = JSON.parse(result.stdout) as StateView;
        const current = (view.run as unknown as { step?: string } | null)?.step;
        return view.phase === phase && (!step || current === step) ? view : undefined;
      },
      { timeoutMs, intervalMs: 500 },
    );
  }

  async ack(): Promise<void> {
    await this.cli(["ack", "--json"]);
  }

  async env(): Promise<string> {
    return readFile(`${this.dir}/.env`);
  }

  /** The value of one env key, or null. */
  async envValue(key: string): Promise<string | null> {
    const line = (await this.env()).split("\n").find((entry) => entry.startsWith(`${key}=`));
    return line === undefined ? null : line.slice(key.length + 1);
  }

  async token(): Promise<string> {
    return (await this.compose(["exec", "-T", "updater", "cat", "/shared/token"])).stdout.trim();
  }

  /** Container id of a service (empty when not running). */
  async containerId(service: string): Promise<string> {
    return (await this.compose(["ps", "-q", service])).stdout.trim();
  }

  /** The image a service's container runs (`repository:tag@digest` as configured). */
  async serviceImage(service: string): Promise<string> {
    const id = await this.containerId(service);
    return (await sh(`docker inspect --format '{{.Config.Image}}' ${q(id)}`)).stdout.trim();
  }

  /** psql in the db service. */
  async sql(query: string, database = "stub", user = "stub"): Promise<string> {
    return (
      await this.compose([
        "exec",
        "-T",
        "db",
        "psql",
        "-X",
        "-q",
        "-At",
        "-U",
        user,
        "-d",
        database,
        "-c",
        query,
      ])
    ).stdout.trim();
  }

  /**
   * SIGKILL the sidecar as soon as its current run reaches `step` (polled inside the host
   * every ~0.3 s through the API), then start it again and wait until it answers.
   */
  async killAt(step: string, timeoutMs = 240_000): Promise<void> {
    const probe = `
const token = require("node:fs").readFileSync("/shared/token", "utf8").trim();
fetch("http://127.0.0.1:8090/v1/state", { headers: { authorization: "Bearer " + token } })
  .then((r) => r.json())
  .then((s) => process.exit(s.phase === "running" && s.run && s.run.step === process.argv[1] ? 0 : 1), () => process.exit(1));
`;
    await sh(
      `cd ${q(this.dir)}
c=$(docker compose --profile updater ps -q updater)
end=$(( $(date +%s) + ${Math.ceil(timeoutMs / 1000)} ))
until docker exec "$c" node -e ${q(probe)} ${q(step)}; do
  [ "$(date +%s)" -lt "$end" ] || { echo "step ${step} not reached" >&2; exit 1; }
  sleep 0.2
done
docker kill -s KILL "$c" > /dev/null`,
      { timeoutMs: timeoutMs + 30_000 },
    );
    await sleep(500);
    await this.compose(["up", "-d", "updater"]);
    await this.ready();
  }

  /** Acknowledge a finished run, cancel a scheduled one (cleanup between scenarios). */
  async settle(): Promise<void> {
    const state = await this.ready();
    if (state.phase === "succeeded" || state.phase === "failed") {
      await this.ack();
    } else if (state.phase === "scheduled") {
      await this.cli(["cancel", "--json"], { allowFail: true });
    } else if (state.phase === "running") {
      await this.finished();
      await this.ack();
    }
  }

  /** Restart the sidecar container (SIGKILL when `kill`). */
  async restartSidecar(kill = false): Promise<void> {
    if (kill) {
      await this.compose(["kill", "-s", "KILL", "updater"]);
    } else {
      await this.compose(["stop", "-t", "30", "updater"]);
    }
    await sleep(500);
    await this.compose(["up", "-d", "updater"]);
    await this.ready();
  }
}

/** The sidecar service as the docs show it (with the test image). */
export function sidecarService(
  image: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    profiles: ["updater"],
    image,
    restart: "unless-stopped",
    stop_grace_period: "30s",
    labels: { "io.github.restow-backup.cicd-updater.role": "sidecar" },
    environment: {
      CICD_UPDATER_CONFIG: "${PROJECT_DIR:?}/updater.yaml",
      CICD_UPDATER_COMPOSE__PROJECT_DIR: "${PROJECT_DIR:?}",
    },
    volumes: [
      "/var/run/docker.sock:/var/run/docker.sock",
      "${PROJECT_DIR:?}:${PROJECT_DIR:?}",
      "updater-state:/state",
      "updater-shared:/shared",
      "updater-verify:/verify",
    ],
    security_opt: ["no-new-privileges:true"],
    ...extra,
  };
}

/** The problem document a refused CLI call printed (--json). */
export function problemOf(result: Result): {
  code: string;
  detail: string;
  [key: string]: unknown;
} {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const problem = (parsed.problem ?? parsed) as Record<string, unknown>;
    return { ...problem, code: String(problem.code ?? ""), detail: String(problem.detail ?? "") };
  } catch {
    throw new Error(
      `not a problem document (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}
