import type {
  AppCheckResult,
  CheckResult,
  Hooks,
  MigrationProbe,
  Redactor,
} from "@cicd-updater/engine";
import { ProbeError } from "@cicd-updater/engine";
import {
  type CheckSpec,
  type ProbePreset,
  scalarText,
  type UpdaterConfig,
  valueAtPath,
} from "@cicd-updater/protocol";
import type { CliDocker } from "./docker.js";

/**
 * The read-only hooks (design 4.3, 5.3): the migration probe, the app health
 * check and the smoke and per-service checks. Commands run inside the app's
 * own containers through `docker compose exec -T`, as argument vectors; SQL
 * runs through constant scripts that take data only as positional parameters
 * (design appendix B).
 */

// ---------------------------------------------------------------------------
// Constant scripts (appendix B)
// ---------------------------------------------------------------------------

/** PostgreSQL query (args: user or "", database or "", sql). */
export const POSTGRES_QUERY_SCRIPT = [
  'u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"',
  'exec psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$u" -d "$d" -c "$3"',
].join("\n");

/** MySQL/MariaDB query (args: user or "", database or "", sql). */
export const MYSQL_QUERY_SCRIPT = [
  'if [ -n "$1" ]; then u="$1"; p="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}";',
  'else u=root; p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; fi',
  'd="${2:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"',
  "c=mysql; command -v mariadb >/dev/null 2>&1 && c=mariadb",
  'MYSQL_PWD="$p" exec "$c" -N -B -u "$u" -e "$3" "$d"',
].join("\n");

/** Wraps a command with `timeout` inside a container (args: seconds, command...). */
export const TIMEOUT_WRAPPER = 't="$1"; shift; exec timeout -s TERM "$t" "$@"';

/** The argv for running a constant script in a database container, wrapped with `timeout` when available. */
export function scriptArgv(
  script: string,
  args: readonly string[],
  timeoutSeconds: number | null,
): string[] {
  const inner = ["sh", "-c", script, "sh", ...args];
  return timeoutSeconds === null
    ? inner
    : ["sh", "-c", TIMEOUT_WRAPPER, "sh", String(timeoutSeconds), ...inner];
}

// ---------------------------------------------------------------------------
// Migration probe presets (appendix C)
// ---------------------------------------------------------------------------

export const PRESET_QUERIES: Readonly<
  Record<ProbePreset, { postgres: string; mysql: string | null }>
> = {
  drizzle: {
    postgres: "SELECT count(*) FROM drizzle.__drizzle_migrations",
    mysql: "SELECT count(*) FROM __drizzle_migrations",
  },
  prisma: {
    postgres: "SELECT count(*) FROM _prisma_migrations",
    mysql: "SELECT count(*) FROM _prisma_migrations",
  },
  knex: {
    postgres: "SELECT count(*) FROM knex_migrations",
    mysql: "SELECT count(*) FROM knex_migrations",
  },
  alembic: {
    postgres:
      "SELECT coalesce(string_agg(version_num, ',' ORDER BY version_num), '') FROM alembic_version",
    mysql:
      "SELECT coalesce(group_concat(version_num ORDER BY version_num), '') FROM alembic_version",
  },
  django: {
    postgres: "SELECT count(*) FROM django_migrations",
    mysql: "SELECT count(*) FROM django_migrations",
  },
  flyway: {
    postgres: "SELECT count(*) FROM flyway_schema_history",
    mysql: "SELECT count(*) FROM flyway_schema_history",
  },
  rails: {
    postgres: "SELECT count(*) FROM schema_migrations",
    mysql: "SELECT count(*) FROM schema_migrations",
  },
  "golang-migrate": {
    postgres: "SELECT version::text || ':' || dirty::text FROM schema_migrations",
    mysql: "SELECT concat(version, ':', dirty) FROM schema_migrations",
  },
  "node-pg-migrate": { postgres: "SELECT count(*) FROM pgmigrations", mysql: null },
  typeorm: {
    postgres: "SELECT count(*) FROM migrations",
    mysql: "SELECT count(*) FROM migrations",
  },
  sequelize: {
    postgres: 'SELECT count(*) FROM "SequelizeMeta"',
    mysql: "SELECT count(*) FROM `SequelizeMeta`",
  },
};

/** MD5 of `schema.table.column:type:nullable:default`, ordered (appendix C). */
export const FINGERPRINT_QUERIES = {
  postgres:
    "SELECT md5(coalesce(string_agg(table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY table_schema, table_name, column_name), '')) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')",
  mysql:
    "SET SESSION group_concat_max_len = 4294967295; SELECT md5(coalesce(group_concat(concat(table_schema, '.', table_name, '.', column_name, ':', column_type, ':', is_nullable, ':', coalesce(column_default, '')) ORDER BY table_schema, table_name, column_name SEPARATOR ','), '')) FROM information_schema.columns WHERE table_schema = DATABASE()",
} as const;

/** A probe value: trimmed, whitespace runs collapsed, at most 1024 printable ASCII characters. */
export function normalizeProbeValue(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length > 1024 || !/^[\x20-\x7e]*$/.test(value)) {
    throw new ProbeError("The probe value is longer than 1024 characters or not printable ASCII.");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const BODY_CAP = 1024 * 1024;

async function readCappedText(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > BODY_CAP) {
      void reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface SidecarHooksOptions {
  config: UpdaterConfig;
  docker: CliDocker;
  redactor: Redactor;
  /** The shared token, sent to the app's health endpoint with `sendToken`. */
  token: () => string;
  /** Whether a service's container has `timeout` (cached by the caller). */
  fetch?: typeof fetch;
}

export class SidecarHooks implements Hooks {
  readonly probe: MigrationProbe;
  private readonly timeoutCapable = new Map<string, boolean>();
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: SidecarHooksOptions) {
    this.fetcher = options.fetch ?? fetch;
    const probe = options.config.hooks.migrationProbe;
    this.probe = {
      configured: probe.type !== "none",
      read: (signal?: AbortSignal) => this.readProbe(signal),
    };
  }

  get appCheckConfigured(): boolean {
    return this.options.config.hooks.health.type !== "none";
  }

  get appReportsVersion(): boolean {
    const health = this.options.config.hooks.health;
    return (
      (health.type === "http" && (health.http?.versionJsonPath ?? null) !== null) ||
      (health.type === "command" && health.command?.versionFromStdout === true)
    );
  }

  /** Whether `timeout` exists in a service's container (asked once per service). */
  async hasTimeout(service: string): Promise<boolean> {
    const known = this.timeoutCapable.get(service);
    if (known !== undefined) {
      return known;
    }
    const result = await this.options.docker.exec(
      service,
      ["sh", "-c", "command -v timeout >/dev/null 2>&1"],
      {
        timeoutMs: 20_000,
      },
    );
    const capable = result.exitCode === 0;
    this.timeoutCapable.set(service, capable);
    return capable;
  }

  /** Run one SQL statement through the constant query script of the database family. */
  async query(
    family: "postgres" | "mysql",
    target: { service: string; user: string | null; database: string | null },
    sql: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const script = family === "postgres" ? POSTGRES_QUERY_SCRIPT : MYSQL_QUERY_SCRIPT;
    const wrapped = (await this.hasTimeout(target.service)) ? timeoutSeconds : null;
    const result = await this.options.docker.exec(
      target.service,
      scriptArgv(script, [target.user ?? "", target.database ?? "", sql], wrapped),
      { timeoutMs: (timeoutSeconds + 10) * 1000, signal, maxOutputBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0) {
      throw new ProbeError(
        `The query failed (exit code ${result.exitCode}${result.timedOut ? ", timed out" : ""}): ${this.options.redactor.oneLine(result.errorTail, 500)}`,
      );
    }
    return result.stdout;
  }

  private async readProbe(signal?: AbortSignal): Promise<string> {
    const probe = this.options.config.hooks.migrationProbe;
    const timeout = probe.timeoutSeconds;
    switch (probe.type) {
      case "none":
        throw new ProbeError("No migration probe is configured.");
      case "postgres":
      case "mysql": {
        const family = probe.type;
        const target = {
          service: probe.service as string,
          user: probe.user,
          database: probe.database,
        };
        const sql = probe.preset ? PRESET_QUERIES[probe.preset][family] : probe.query;
        if (!sql) {
          throw new ProbeError(`The preset ${probe.preset} has no ${family} query.`);
        }
        const value = normalizeProbeValue(await this.query(family, target, sql, timeout, signal));
        if (!probe.fingerprint) {
          return value;
        }
        const fingerprint = normalizeProbeValue(
          await this.query(family, target, FINGERPRINT_QUERIES[family], timeout, signal),
        );
        return `${value}#${fingerprint}`;
      }
      case "command": {
        const command = probe.command as { service: string; argv: string[] };
        const result = await this.options.docker.exec(command.service, command.argv, {
          timeoutMs: timeout * 1000,
          signal,
          maxOutputBytes: 64 * 1024,
        });
        if (result.exitCode !== 0) {
          throw new ProbeError(`The probe command failed (exit code ${result.exitCode}).`);
        }
        return normalizeProbeValue(result.stdout);
      }
      case "http": {
        const http = probe.http as { url: string; jsonPath: string };
        const response = await this.get(http.url, true, timeout).catch((error: Error) => {
          throw new ProbeError(
            `The probe request failed: ${this.options.redactor.oneLine(error.message, 300)}`,
          );
        });
        if (!response.ok) {
          throw new ProbeError(`The probe answered HTTP ${response.status}.`);
        }
        let body: unknown;
        try {
          body = JSON.parse(await readCappedText(response));
        } catch {
          throw new ProbeError("The probe answer is not JSON.");
        }
        const text = scalarText(valueAtPath(body, http.jsonPath));
        if (text === null) {
          throw new ProbeError(`The probe answer has no value at ${http.jsonPath}.`);
        }
        return normalizeProbeValue(text);
      }
    }
  }

  private get(url: string, sendToken: boolean, timeoutSeconds: number): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "cicd-updater/1",
    };
    if (sendToken) {
      headers.authorization = `Bearer ${this.options.token()}`;
    }
    // The token never follows a redirect.
    return this.fetcher(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  }

  async appCheck(): Promise<AppCheckResult | null> {
    const health = this.options.config.hooks.health;
    if (health.type === "none") {
      return null;
    }
    if (health.type === "command") {
      const command = health.command as {
        service: string;
        argv: string[];
        versionFromStdout: boolean;
      };
      const result = await this.options.docker.exec(command.service, command.argv, {
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0) {
        return { healthy: false, version: null, detail: `exit code ${result.exitCode}` };
      }
      const version = command.versionFromStdout
        ? (result.stdout.split("\n")[0]?.trim() ?? null) || null
        : null;
      return { healthy: true, version, detail: null };
    }
    const http = health.http as NonNullable<UpdaterConfig["hooks"]["health"]["http"]>;
    let response: Response;
    try {
      response = await this.get(http.url, http.sendToken, http.requestTimeoutSeconds);
    } catch (error) {
      return {
        healthy: false,
        version: null,
        detail: this.options.redactor.oneLine(`request failed: ${(error as Error).message}`, 300),
      };
    }
    if (!http.expectStatus.includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return { healthy: false, version: null, detail: `HTTP ${response.status}` };
    }
    if (http.versionJsonPath === null && http.conditions.length === 0) {
      void response.body?.cancel().catch(() => undefined);
      return { healthy: true, version: null, detail: null };
    }
    let body: unknown;
    try {
      body = JSON.parse(await readCappedText(response));
    } catch {
      return { healthy: false, version: null, detail: "the answer is not JSON" };
    }
    for (const condition of http.conditions) {
      if (valueAtPath(body, condition.path) !== condition.equals) {
        return {
          healthy: false,
          version: null,
          detail: `condition ${condition.path} does not hold`,
        };
      }
    }
    const version = http.versionJsonPath
      ? scalarText(valueAtPath(body, http.versionJsonPath))
      : null;
    return { healthy: true, version, detail: null };
  }

  async check(spec: CheckSpec): Promise<CheckResult> {
    if (spec.type === "command") {
      const result = await this.options.docker.exec(spec.service, spec.argv, {
        timeoutMs: 60_000,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode === spec.expectExitCode) {
        return { ok: true, detail: `exit code ${result.exitCode}` };
      }
      return {
        ok: false,
        detail: this.options.redactor.oneLine(
          `exit code ${result.exitCode}: ${result.errorTail}`,
          500,
        ),
      };
    }
    let response: Response;
    try {
      response = await this.get(spec.url, spec.sendToken, 30);
    } catch (error) {
      return {
        ok: false,
        detail: this.options.redactor.oneLine(`request failed: ${(error as Error).message}`, 300),
      };
    }
    const text = spec.bodyContains !== null ? await readCappedText(response) : "";
    if (spec.bodyContains === null) {
      void response.body?.cancel().catch(() => undefined);
    }
    if (!spec.expectStatus.includes(response.status)) {
      return {
        ok: false,
        detail: this.options.redactor.oneLine(
          `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
          400,
        ),
      };
    }
    if (spec.bodyContains !== null && !text.includes(spec.bodyContains)) {
      return {
        ok: false,
        detail: `HTTP ${response.status}, the body does not contain the expected text`,
      };
    }
    return { ok: true, detail: `HTTP ${response.status}` };
  }
}
