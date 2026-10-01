import { readFile } from "node:fs/promises";
import {
  type BackupInfo,
  backupsViewSchema,
  type Capabilities,
  capabilitiesSchema,
  type EventsView,
  eventsViewSchema,
  type Problem,
  type PublicStatus,
  publicStatusSchema,
  type ReleasesView,
  type Run,
  type RunSummary,
  releasesViewSchema,
  runSchema,
  runsViewSchema,
  type ScheduleRequest,
  type StateView,
  stateViewSchema,
  type VerificationResult,
  verificationResultSchema,
} from "@cicd-updater/protocol";
import type { z } from "zod";

/**
 * The app's client for the sidecar's HTTP API (design 7.2). The sidecar is
 * opt-in, so "nothing answers" is a normal result: `state()` resolves to null.
 * The token is read from the shared token file (re-read after 30 s and after
 * a 401), sent only to the configured URL and never follows a redirect.
 */

export type UnavailableReason =
  | "disabled"
  | "no_token"
  | "unreachable"
  | "timeout"
  | "incompatible";

/** No usable sidecar answered (not running, not reachable, no token, or another major version). */
export class UpdaterUnavailableError extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(`the updater is unavailable (${reason})`);
    this.name = "UpdaterUnavailableError";
  }
}

/** The sidecar answered with an RFC 9457 problem document. */
export class UpdaterProblemError extends Error {
  readonly code: string;

  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail ?? problem.title ?? `the updater refused the request (${status})`);
    this.name = "UpdaterProblemError";
    this.code = problem.code;
  }
}

export interface UpdaterClientOptions {
  /** For example `http://updater:8090`; a trailing slash is fine. Empty: the client is disabled. */
  url: string;
  token?: string;
  /** Re-read after 30 s and after every 401 (a new token after a volume reset). */
  tokenFile?: string;
  /** Default 5000 (verification and scheduling: 120000). */
  timeoutMs?: number;
  /** Concurrent and repeated state() calls within this window share one request (default 2000). */
  stateTtlMs?: number;
  /** How long "nothing answers" is remembered (default 8000). */
  unavailableTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
}

export interface UpdaterClient {
  /** The state, or null when no sidecar answers. `fresh` skips the short cache. */
  state(options?: { fresh?: boolean; refreshCapabilities?: boolean }): Promise<StateView | null>;
  capabilities(options?: { refresh?: boolean }): Promise<Capabilities>;
  releases(options?: { refresh?: boolean }): Promise<ReleasesView>;
  verifyRelease(version: string): Promise<VerificationResult>;
  schedule(request: ScheduleRequest): Promise<StateView>;
  reschedule(
    runId: string,
    when: { leadSeconds: number } | { startsAt: string | Date },
    requestedBy?: { id?: string | null; label: string },
  ): Promise<StateView>;
  /** Cancel a scheduled run or abort a running one before the point of no return (see run.abortRequestedAt). */
  cancel(runId: string, requestedBy?: { id?: string | null; label: string }): Promise<StateView>;
  acknowledge(
    runId: string,
    requestedBy?: { id?: string | null; label: string },
  ): Promise<StateView>;
  run(runId: string): Promise<Run>;
  history(limit?: number): Promise<RunSummary[]>;
  events(after: string | null, limit?: number): Promise<EventsView>;
  backups(): Promise<BackupInfo[]>;
  publicStatus(): Promise<PublicStatus>;
}

const TOKEN_TTL_MS = 30_000;

class TokenReader {
  private cached: { value: string; at: number } | null = null;

  constructor(
    private readonly options: Pick<UpdaterClientOptions, "token" | "tokenFile">,
    private readonly read: (path: string) => Promise<string>,
    private readonly now: () => number,
  ) {}

  async get(): Promise<string | null> {
    if (this.options.token) {
      return this.options.token;
    }
    if (!this.options.tokenFile) {
      return null;
    }
    if (this.cached && this.now() - this.cached.at < TOKEN_TTL_MS) {
      return this.cached.value;
    }
    try {
      const value = (await this.read(this.options.tokenFile)).trim();
      this.cached = value ? { value, at: this.now() } : null;
      return value || null;
    } catch {
      this.cached = null;
      return null;
    }
  }

  forget(): void {
    this.cached = null;
  }
}

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5000;
  const slowTimeoutMs = Math.max(timeoutMs, 120_000);
  const stateTtl = options.stateTtlMs ?? 2000;
  const unavailableTtl = options.unavailableTtlMs ?? 8000;
  const base = options.url.trim() ? options.url.trim().replace(/\/+$/, "") : null;
  const tokens = new TokenReader(
    options,
    options.readFile ?? ((path) => readFile(path, "utf8")),
    now,
  );
  let cachedState: {
    at: number;
    value: StateView | null;
    reason: UnavailableReason | null;
  } | null = null;
  let inFlight: Promise<StateView | null> | null = null;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    slow = false,
    retried = false,
  ): Promise<unknown> {
    if (!base) {
      throw new UpdaterUnavailableError("disabled");
    }
    const token = await tokens.get();
    if (!token) {
      throw new UpdaterUnavailableError("no_token");
    }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(slow ? slowTimeoutMs : timeoutMs),
        // The token never follows a redirect.
        redirect: "error",
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new UpdaterUnavailableError(timedOut ? "timeout" : "unreachable");
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.status === 401) {
      tokens.forget();
      if (!retried && options.tokenFile && !options.token) {
        return await request(method, path, body, slow, true);
      }
      throw new UpdaterUnavailableError("no_token");
    }
    if (!response.ok) {
      const problem =
        parsed && typeof parsed === "object" && typeof (parsed as Problem).code === "string"
          ? (parsed as Problem)
          : null;
      if (!problem) {
        throw new UpdaterUnavailableError(response.status === 404 ? "incompatible" : "unreachable");
      }
      throw new UpdaterProblemError(response.status, problem);
    }
    return parsed;
  }

  function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new UpdaterUnavailableError("incompatible");
    }
    return result.data;
  }

  const remember = (view: StateView): StateView => {
    cachedState = { at: now(), value: view, reason: null };
    return view;
  };

  async function loadState(refresh: boolean): Promise<StateView | null> {
    try {
      return remember(
        parse(
          stateViewSchema,
          await request("GET", refresh ? "/v1/state?refresh=true" : "/v1/state"),
        ) as StateView,
      );
    } catch (error) {
      if (error instanceof UpdaterUnavailableError) {
        cachedState = { at: now(), value: null, reason: error.reason };
        if (error.reason === "incompatible") {
          throw error;
        }
        return null;
      }
      throw error;
    }
  }

  const actorBody = (requestedBy?: { id?: string | null; label: string }) =>
    requestedBy ? { requestedBy } : undefined;

  return {
    async state(callOptions = {}) {
      if (!base) {
        return null;
      }
      if (!callOptions.fresh && !callOptions.refreshCapabilities && cachedState) {
        const ttl = cachedState.value ? stateTtl : unavailableTtl;
        if (now() - cachedState.at < ttl) {
          if (cachedState.reason === "incompatible") {
            throw new UpdaterUnavailableError("incompatible");
          }
          return cachedState.value;
        }
      }
      inFlight ??= loadState(callOptions.refreshCapabilities === true).finally(() => {
        inFlight = null;
      });
      return await inFlight;
    },
    async capabilities(callOptions = {}) {
      return parse(
        capabilitiesSchema,
        await request("GET", `/v1/capabilities${callOptions.refresh ? "?refresh=true" : ""}`),
      ) as Capabilities;
    },
    async releases(callOptions = {}) {
      return parse(
        releasesViewSchema,
        await request(
          "GET",
          `/v1/releases${callOptions.refresh ? "?refresh=true" : ""}`,
          undefined,
          true,
        ),
      );
    },
    async verifyRelease(version) {
      return parse(
        verificationResultSchema,
        await request(
          "POST",
          `/v1/releases/${encodeURIComponent(version)}/verification`,
          undefined,
          true,
        ),
      );
    },
    async schedule(scheduleRequest) {
      return remember(
        parse(
          stateViewSchema,
          await request("POST", "/v1/runs", scheduleRequest, true),
        ) as StateView,
      );
    },
    async reschedule(runId, when, requestedBy) {
      const body =
        "leadSeconds" in when
          ? { leadSeconds: when.leadSeconds }
          : {
              startsAt: when.startsAt instanceof Date ? when.startsAt.toISOString() : when.startsAt,
            };
      return remember(
        parse(
          stateViewSchema,
          await request("PATCH", `/v1/runs/${encodeURIComponent(runId)}`, {
            ...body,
            ...(actorBody(requestedBy) ?? {}),
          }),
        ) as StateView,
      );
    },
    async cancel(runId, requestedBy) {
      return remember(
        parse(
          stateViewSchema,
          await request(
            "POST",
            `/v1/runs/${encodeURIComponent(runId)}/cancel`,
            actorBody(requestedBy),
          ),
        ) as StateView,
      );
    },
    async acknowledge(runId, requestedBy) {
      return remember(
        parse(
          stateViewSchema,
          await request(
            "POST",
            `/v1/runs/${encodeURIComponent(runId)}/acknowledge`,
            actorBody(requestedBy),
          ),
        ) as StateView,
      );
    },
    async run(runId) {
      return parse(runSchema, await request("GET", `/v1/runs/${encodeURIComponent(runId)}`));
    },
    async history(limit = 20) {
      return parse(runsViewSchema, await request("GET", `/v1/runs?limit=${limit}`)).runs;
    },
    async events(after, limit = 100) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (after) {
        query.set("after", after);
      }
      return parse(eventsViewSchema, await request("GET", `/v1/events?${query.toString()}`));
    },
    async backups() {
      return parse(backupsViewSchema, await request("GET", "/v1/backups")).backups;
    },
    async publicStatus() {
      return parse(publicStatusSchema, await request("GET", "/public/v1/status"));
    },
  };
}
