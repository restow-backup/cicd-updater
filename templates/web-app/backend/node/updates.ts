import {
  DEFAULT_LEAD_TIMES,
  maintenanceViewOf,
  type StateView,
  type UpdaterClient,
  UpdaterProblemError,
  UpdaterUnavailableError,
} from "@restow-backup/cicd-updater";
import { isPlainVersion } from "@restow-backup/cicd-updater/semver";

/**
 * cicd-updater: the app's update endpoints, framework-neutral. They take a web-standard
 * `Request` and return a `Response` (Hono, Next.js route handlers, Remix, SvelteKit, Bun
 * and Deno use these directly; Express goes through adapters/express.ts).
 *
 *   GET  /api/maintenance                         every signed-in user: the banner
 *   GET  /api/admin/updates                       admin: the sidecar's state (null: none)
 *   GET  /api/admin/updates/releases[?refresh=1]  admin: releases and why one is refused
 *   POST /api/admin/updates                       admin with a recent strong sign-in: schedule
 *   POST /api/admin/updates/{runId}/cancel        admin: cancel, or abort before the point of no return
 *   POST /api/admin/updates/{runId}/acknowledge   admin: clear a finished run
 *
 * The sidecar trusts whoever holds its token, so this file decides who may act
 * (docs/app-integration.md, section 1). Every place you must adapt is marked
 * TODO(cicd-updater).
 */

/** The caller, as your app's session knows it. */
export interface Actor {
  /** Your user id; recorded by the sidecar in the run and the journal (at most 200 characters). */
  id: string;
  /** What an auditor recognises, for example the email address (1 to 200 characters). */
  label: string;
  /** An installation-level admin, not a tenant or project admin: an update affects everyone. */
  isInstallationAdmin: boolean;
  /** Support staff acting as this user. Never counts for update actions. */
  impersonated: boolean;
  /** Last sign-in with a strong method (passkey, password plus TOTP, OIDC); null: none. */
  strongAuthAt: Date | null;
}

export type UpdateAction =
  | "updates.read"
  | "updates.releases"
  | "updates.schedule"
  | "updates.cancel"
  | "updates.acknowledge";

/**
 * What only the app sees. Accepted actions are NOT passed here: the sidecar journals
 * them itself, and journal.ts copies the journal into your audit log exactly once.
 */
export interface AuditEntry {
  action: UpdateAction;
  /** denied: authorization failed. refused: the sidecar said no. failed: no sidecar answered. */
  outcome: "denied" | "refused" | "failed";
  /** `forbidden`, `step_up_required`, a sidecar problem code such as `blocked`, or `updater_unavailable`. */
  code: string;
  actor: Actor | null;
  /** The version or run id the request named. */
  target: string | null;
  at: Date;
}

export interface UpdateRoutesOptions {
  updater: UpdaterClient;
  /** Path prefix of your API. Default `/api`. */
  basePath?: string;
  /** How recent a strong sign-in must be to schedule. Default 10 minutes. */
  stepUpMaxAgeMs?: number;
  /** TODO(cicd-updater): write the entry into your audit log (a denied or refused attempt). */
  audit?: (entry: AuditEntry) => Promise<void>;
  /** Clock, for tests. */
  now?: () => Date;
}

/** The body of `GET /api/admin/updates`. */
export interface AdminUpdatesView {
  /** null: no sidecar on this installation; show the manual update steps. */
  state: StateView | null;
  /** Lead times for the schedule form, in seconds: now, 1, 5, 15, 30 and 60 minutes. */
  leadTimes: readonly number[];
  stepUpMaxAgeSeconds: number;
}

export interface UpdateRoutes {
  /** Whether a path belongs to these routes (adapters check it before reading a body). */
  matches(pathname: string): boolean;
  /** The response, or null when the request is not one of these routes. */
  handle(request: Request, actor: Actor | null): Promise<Response | null>;
}

const MAX_BODY_BYTES = 16_384;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ACTIONS = /^\/admin\/updates\/([^/]+)\/(cancel|acknowledge)$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Sidecar problems keep their status and code (a 409 `blocked` stays 409 with its blockers). */
function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(error.status, { code: error.code, ...error.extra });
  }
  if (error instanceof UpdaterProblemError) {
    const { blockers, reasons, errors, feedError } = error.problem;
    return json(error.status, { code: error.code, blockers, reasons, errors, feedError });
  }
  if (error instanceof UpdaterUnavailableError) {
    return json(503, { code: "updater_unavailable", reason: error.reason });
  }
  throw error;
}

/**
 * POST bodies must be JSON. A cross-site HTML form cannot send `application/json`
 * without a CORS preflight, so this also blocks the simplest CSRF. Your app's own CSRF
 * protection still applies.
 */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    throw new HttpError(415, "unsupported_media_type");
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large");
  }
  try {
    const value: unknown = JSON.parse(text || "{}");
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // not JSON: the same answer as a body that is not an object
  }
  throw new HttpError(422, "invalid_request");
}

export function createUpdateRoutes(options: UpdateRoutesOptions): UpdateRoutes {
  const { updater } = options;
  const base = (options.basePath ?? "/api").replace(/\/+$/, "");
  const stepUpMs = options.stepUpMaxAgeMs ?? 10 * 60_000;
  const now = options.now ?? (() => new Date());

  /** null: allowed. TODO(cicd-updater): adapt to your roles if `Actor` does not fit. */
  function denial(actor: Actor | null, needs: { admin: boolean; stepUp: boolean }) {
    if (!actor) {
      return new HttpError(401, "unauthorized");
    }
    if (!needs.admin) {
      return null;
    }
    if (!actor.isInstallationAdmin || actor.impersonated) {
      return new HttpError(403, "forbidden");
    }
    const strongAt = actor.strongAuthAt?.getTime() ?? 0;
    if (needs.stepUp && now().getTime() - strongAt > stepUpMs) {
      // Your UI turns this into a "confirm it is you" dialog and retries.
      return new HttpError(403, "step_up_required", { maxAgeSeconds: stepUpMs / 1000 });
    }
    return null;
  }

  /** Authorize first, then run; audit what was denied or refused. */
  async function asAdmin(
    action: UpdateAction,
    actor: Actor | null,
    target: () => string | null,
    stepUp: boolean,
    run: (actor: Actor) => Promise<Response>,
  ): Promise<Response> {
    const audit = async (outcome: AuditEntry["outcome"], code: string) =>
      options.audit?.({ action, outcome, code, actor, target: target(), at: now() });
    const denied = denial(actor, { admin: true, stepUp });
    if (denied || !actor) {
      const error = denied ?? new HttpError(401, "unauthorized");
      await audit("denied", error.code);
      return errorResponse(error);
    }
    try {
      return await run(actor);
    } catch (error) {
      // Reads are polled; only actions are audited when the sidecar refuses or is missing.
      if (action !== "updates.read" && action !== "updates.releases") {
        if (error instanceof UpdaterProblemError) {
          await audit("refused", error.code);
        } else if (error instanceof UpdaterUnavailableError) {
          await audit("failed", "updater_unavailable");
        }
      }
      return errorResponse(error);
    }
  }

  // The sidecar accepts an id of at most 200 and a label of 1 to 200 characters.
  const requestedBy = (actor: Actor) => ({
    id: actor.id.slice(0, 200),
    label: (actor.label || actor.id).slice(0, 200),
  });

  function matches(pathname: string): boolean {
    return (
      pathname === `${base}/maintenance` ||
      pathname === `${base}/admin/updates` ||
      pathname.startsWith(`${base}/admin/updates/`)
    );
  }

  async function handle(request: Request, actor: Actor | null): Promise<Response | null> {
    const url = new URL(request.url);
    if (!matches(url.pathname)) {
      return null;
    }
    const path = url.pathname.slice(base.length);
    const method = request.method.toUpperCase();

    // The banner: every signed-in user. Never the full StateView (it holds image
    // references, paths and the run log, which are for admins).
    if (method === "GET" && path === "/maintenance") {
      const denied = denial(actor, { admin: false, stepUp: false });
      if (denied) {
        return errorResponse(denied);
      }
      return json(200, maintenanceViewOf(await updater.state().catch(() => null)));
    }

    if (method === "GET" && path === "/admin/updates") {
      return asAdmin(
        "updates.read",
        actor,
        () => null,
        false,
        async () => {
          const view: AdminUpdatesView = {
            state: await updater.state({ fresh: true }),
            leadTimes: DEFAULT_LEAD_TIMES,
            stepUpMaxAgeSeconds: stepUpMs / 1000,
          };
          return json(200, view);
        },
      );
    }

    if (method === "GET" && path === "/admin/updates/releases") {
      // Slow: the sidecar asks the release host (up to 120 seconds).
      return asAdmin(
        "updates.releases",
        actor,
        () => null,
        false,
        async () =>
          json(200, await updater.releases({ refresh: url.searchParams.get("refresh") === "1" })),
      );
    }

    if (method === "POST" && path === "/admin/updates") {
      let version: string | null = null;
      return asAdmin(
        "updates.schedule",
        actor,
        () => version,
        true,
        async (admin) => {
          const body = await readJson(request);
          const { leadSeconds, releaseSha256 } = body;
          version = typeof body.version === "string" ? body.version.slice(0, 64) : null;
          if (version === null || !isPlainVersion(version)) {
            throw new HttpError(422, "invalid_request", { field: "version" });
          }
          if (
            typeof leadSeconds !== "number" ||
            !Number.isInteger(leadSeconds) ||
            leadSeconds < 0
          ) {
            throw new HttpError(422, "invalid_request", { field: "leadSeconds" });
          }
          // The hash of the release.json the admin was shown: what they saw is what gets
          // installed (409 release_mismatch otherwise).
          if (typeof releaseSha256 !== "string" || !SHA256.test(releaseSha256)) {
            throw new HttpError(422, "invalid_request", { field: "releaseSha256" });
          }
          const state = await updater.schedule({
            version,
            leadSeconds, // the sidecar enforces schedule.maxLeadSeconds
            requestedBy: requestedBy(admin),
            expect: { releaseSha256 },
          });
          return json(202, state);
        },
      );
    }

    const action = method === "POST" ? ACTIONS.exec(path) : null;
    if (action?.[1] && action[2]) {
      const runId = action[1];
      const name = action[2] === "cancel" ? "updates.cancel" : "updates.acknowledge";
      return asAdmin(
        name,
        actor,
        () => runId.slice(0, 64),
        false,
        async (admin) => {
          await readJson(request); // no fields; JSON only, as for every POST
          if (!RUN_ID.test(runId)) {
            throw new HttpError(404, "not_found");
          }
          // cancel: a scheduled run is cancelled; a running one gets `run.abortRequestedAt`
          // and stops at its next check point, or the sidecar answers 409 point_of_no_return.
          const state =
            name === "updates.cancel"
              ? await updater.cancel(runId, requestedBy(admin))
              : await updater.acknowledge(runId, requestedBy(admin));
          return json(200, state);
        },
      );
    }

    return null;
  }

  return { matches, handle };
}
