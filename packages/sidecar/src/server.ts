import {
  type BackupStore,
  EngineError,
  type Logger,
  type PreflightPort,
  type Redactor,
  type ReleaseService,
  type RunningVersionResolver,
  type SourceBuilder,
  type UpdateEngine,
} from "@cicd-updater/engine";
import {
  type Actor,
  API_VERSION,
  describeKeyless,
  isPlainVersion,
  openApiDocument,
  PROBLEM_STATUS,
  type Problem,
  type ProblemCode,
  problemType,
  publicStatusOf,
  type Run,
  rescheduleRequestSchema,
  type StateView,
  scheduleRequestSchema,
  type UpdaterConfig,
} from "@cicd-updater/protocol";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { isAuthorized } from "./auth.js";
import { configView } from "./config-file.js";
import { MAINTENANCE_CSP, type PageFile } from "./maintenance.js";

/**
 * The sidecar's HTTP API (design 6): JSON in and out, RFC 9457 problem
 * documents for errors, `Authorization: Bearer <token>` for everything under
 * `/v1`, nothing in any response that carries the token, a path outside the
 * project, an image of an anonymous visitor's interest or an unredacted log.
 */

const MAX_BODY_BYTES = 64 * 1024;
const RUN_ID = /^r-\d{1,15}-[0-9a-f]{4}$/;
const EVENT_ID = /^\d{15}-\d{6}$/;
export const CLIENT_HEADER = "x-cicd-updater-client";

const TITLES: Record<ProblemCode, string> = {
  unauthorized: "A valid bearer token is required",
  not_found: "Not found",
  unsupported_media_type: "The request body must be JSON",
  payload_too_large: "The request body is too large",
  invalid_request: "The request is not valid",
  release_not_found: "The release was not found",
  release_unverifiable: "The release does not verify",
  release_refused: "The release cannot be installed now",
  release_mismatch: "The release document differs from the expected one",
  source_not_allowed: "Source mode is not allowed for this repository",
  busy: "An update is already scheduled or running",
  blocked: "The updater cannot start an update now",
  not_scheduled: "No update is scheduled",
  point_of_no_return: "The update passed the point of no return",
  not_finished: "The update has not finished",
  feed_unavailable: "The release feed is not available",
  internal: "The updater could not handle the request",
};

/** A problem document response. */
export function problem(
  code: ProblemCode,
  detail?: string,
  extensions: Partial<Problem> = {},
): Response {
  const status = PROBLEM_STATUS[code];
  const body: Problem = {
    type: problemType(code),
    title: TITLES[code],
    status,
    code,
    ...(detail ? { detail } : {}),
    ...extensions,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(code === "unauthorized" ? { "WWW-Authenticate": "Bearer" } : {}),
    },
  });
}

function fromEngineError(error: EngineError): Response {
  const extensions: Partial<Problem> = {};
  if (error.extensions.blockers) extensions.blockers = error.extensions.blockers;
  if (error.extensions.reasons) extensions.reasons = error.extensions.reasons;
  if (error.extensions.checks) extensions.checks = error.extensions.checks;
  if (error.extensions.feedError) extensions.feedError = error.extensions.feedError;
  if (error.extensions.errors) extensions.errors = error.extensions.errors.slice(0, 10);
  return problem(error.code, error.message, extensions);
}

function zodErrors(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "body",
    message: issue.message,
  }));
}

export interface ServerDeps {
  config: UpdaterConfig;
  configHash: string;
  updaterVersion: string;
  engine: UpdateEngine;
  preflight: PreflightPort;
  releases: ReleaseService;
  running: RunningVersionResolver;
  backups: BackupStore;
  source: SourceBuilder;
  token: () => string;
  now: () => Date;
  logger: Logger;
  redactor: Redactor;
  /** A newer sidecar release (selfCheck), when known. */
  latestAvailable: () => string | null;
  maintenance: () => Promise<Record<string, PageFile>>;
  /** The peer address of a request (loopback marks the CLI); null when unknown. */
  remoteAddress: (c: Context) => string | null;
}

const optionalActor = z
  .strictObject({
    requestedBy: z
      .strictObject({
        id: z.string().max(200).nullable().optional(),
        label: z.string().min(1).max(200),
      })
      .optional(),
  })
  .optional();

export function buildServer(deps: ServerDeps): Hono {
  const app = new Hono();
  const { config } = deps;

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
  });

  const via = (c: Context): "api" | "cli" => {
    const address = deps.remoteAddress(c);
    const loopback = address !== null && /^(127\.|::1$|::ffff:127\.)/.test(address);
    return loopback && c.req.header(CLIENT_HEADER) === "cli" ? "cli" : "api";
  };

  const actorOf = (c: Context, body: z.infer<typeof optionalActor>): Actor => {
    const where = via(c);
    return {
      id: body?.requestedBy?.id ?? null,
      label: body?.requestedBy?.label ?? (where === "cli" ? "cli" : "api"),
      via: where,
    };
  };

  /** Read a JSON body: 415 for other types, 413 past 64 KiB, 422 for invalid JSON. */
  const readJson = async (
    c: Context,
    required: boolean,
  ): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> => {
    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return {
        ok: false,
        response: problem("payload_too_large", `At most ${MAX_BODY_BYTES} bytes.`),
      };
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return {
        ok: false,
        response: problem("payload_too_large", `At most ${MAX_BODY_BYTES} bytes.`),
      };
    }
    if (text.trim() === "") {
      return required
        ? {
            ok: false,
            response: problem("invalid_request", "A JSON body is required.", {
              errors: [{ path: "body", message: "required" }],
            }),
          }
        : { ok: true, value: undefined };
    }
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (!type.startsWith("application/json")) {
      return { ok: false, response: problem("unsupported_media_type", "Send application/json.") };
    }
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return {
        ok: false,
        response: problem("invalid_request", "The body is not valid JSON.", {
          errors: [{ path: "body", message: "not JSON" }],
        }),
      };
    }
  };

  const stateView = async (refresh: boolean): Promise<StateView> => {
    const view = deps.engine.view();
    const features = ["abort", "reschedule", "verification", "events", "backups"];
    if (config.publicStatus.enabled) features.push("public_status");
    if (config.maintenancePage.enabled) features.push("maintenance_page");
    if (deps.source.allowed()) features.push("source_mode");
    if (config.hooks.backup.encryption.ageRecipients.length > 0) features.push("encryption");
    const running = await deps.running.detect(refresh);
    return {
      api: { version: API_VERSION, features },
      updater: {
        version: deps.updaterVersion,
        configHash: deps.configHash,
        latestAvailable: deps.latestAvailable(),
      },
      phase: view.phase,
      run: view.run,
      history: view.history,
      running: { version: running.version, source: running.source },
      trust: {
        mode: config.trust.mode,
        identity: config.trust.keyless
          ? describeKeyless(config.trust.keyless, config.release.tagPattern)
          : null,
        keys: config.trust.key ? config.trust.key.publicKeyFiles.length : null,
      },
      sourceMode: { enabled: deps.source.allowed(), allowlist: [...config.source.allowlist] },
      capabilities: await deps.preflight.get(refresh),
      serverTime: deps.now().toISOString(),
    };
  };

  const refreshOf = (c: Context): boolean => {
    const value = c.req.query("refresh");
    return value === "1" || value === "true";
  };

  // -- unauthenticated ----------------------------------------------------------

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/public/v1/status", (c) => {
    if (!config.publicStatus.enabled) {
      return problem("not_found", "The public status is disabled.");
    }
    const view = deps.engine.view();
    return c.json(
      publicStatusOf(view.phase, view.run, deps.now(), config.publicStatus.showVersions),
    );
  });

  app.get("/public/v1/maintenance", (c) => c.redirect("/public/v1/maintenance/", 308));
  const maintenancePage = async (name: string): Promise<Response> => {
    if (!config.maintenancePage.enabled) {
      return problem("not_found", "The maintenance page is disabled.");
    }
    const file = (await deps.maintenance())[name];
    if (!file) {
      return problem("not_found");
    }
    return new Response(typeof file.body === "string" ? file.body : new Uint8Array(file.body), {
      status: 200,
      headers: {
        "Content-Type": file.type,
        "Content-Security-Policy": MAINTENANCE_CSP,
        "Referrer-Policy": "no-referrer",
      },
    });
  };
  app.get("/public/v1/maintenance/", () => maintenancePage("index.html"));
  app.get("/public/v1/maintenance/:file{[A-Za-z0-9][A-Za-z0-9._-]*}", (c) =>
    maintenancePage(c.req.param("file")),
  );

  // -- authenticated ------------------------------------------------------------

  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c.req.header("authorization"), deps.token())) {
      return problem("unauthorized", "Send Authorization: Bearer <token>.");
    }
    await next();
    return undefined;
  });

  app.get("/v1/state", async (c) => c.json(await stateView(refreshOf(c))));

  app.get("/v1/capabilities", async (c) => c.json(await deps.preflight.get(refreshOf(c))));

  app.get("/v1/releases", async (c) => {
    try {
      return c.json(await deps.releases.releasesView(refreshOf(c)));
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
  });

  app.post("/v1/releases/:version/verification", async (c) => {
    const version = c.req.param("version");
    if (!isPlainVersion(version)) {
      return problem("invalid_request", "The version is not a plain version.", {
        errors: [{ path: "version", message: "not a plain version" }],
      });
    }
    try {
      const { result } = await deps.releases.verification(version, "image");
      return c.json(result);
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
  });

  app.post("/v1/runs", async (c) => {
    const body = await readJson(c, true);
    if (!body.ok) return body.response;
    const parsed = scheduleRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return problem("invalid_request", "The schedule request is not valid.", {
        errors: zodErrors(parsed.error),
      });
    }
    try {
      await deps.engine.schedule(parsed.data, via(c));
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
    return c.json(await stateView(false), 202);
  });

  app.get("/v1/runs", (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? 20 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return problem("invalid_request", "limit must be 1 to 100.", {
        errors: [{ path: "limit", message: "1 to 100" }],
      });
    }
    return c.json({ runs: deps.engine.view().history.slice(0, limit) });
  });

  app.get("/v1/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const view = deps.engine.view();
    if (view.run?.id === runId) {
      return c.json(view.run);
    }
    const summary = view.history.find((entry) => entry.id === runId);
    if (!summary) {
      return problem("not_found", "There is no run with this id.");
    }
    const run: Run = { ...summary, log: [] };
    return c.json(run);
  });

  app.patch("/v1/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    if (!RUN_ID.test(runId)) return problem("not_found");
    const body = await readJson(c, true);
    if (!body.ok) return body.response;
    const raw = (body.value ?? {}) as Record<string, unknown>;
    const { requestedBy, ...when } = raw;
    const parsed = rescheduleRequestSchema.safeParse(when);
    const actor = optionalActor.safeParse(requestedBy === undefined ? undefined : { requestedBy });
    if (!parsed.success || !actor.success) {
      return problem("invalid_request", "The reschedule request is not valid.", {
        errors: parsed.success ? zodErrors(actor.error as z.ZodError) : zodErrors(parsed.error),
      });
    }
    try {
      await deps.engine.reschedule(runId, parsed.data, actorOf(c, actor.data));
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
    return c.json(await stateView(false));
  });

  const actorBody = async (c: Context) => {
    const body = await readJson(c, false);
    if (!body.ok) return { ok: false as const, response: body.response };
    const parsed = optionalActor.safeParse(body.value);
    if (!parsed.success) {
      return {
        ok: false as const,
        response: problem("invalid_request", "The body is not valid.", {
          errors: zodErrors(parsed.error),
        }),
      };
    }
    return { ok: true as const, actor: actorOf(c, parsed.data) };
  };

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const body = await actorBody(c);
    if (!body.ok) return body.response;
    try {
      const result = await deps.engine.cancel(c.req.param("runId"), body.actor);
      return c.json(await stateView(false), result === "cancelled" ? 200 : 202);
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
  });

  app.post("/v1/runs/:runId/acknowledge", async (c) => {
    const body = await actorBody(c);
    if (!body.ok) return body.response;
    try {
      await deps.engine.acknowledge(c.req.param("runId"), body.actor);
      return c.json(await stateView(false));
    } catch (error) {
      if (error instanceof EngineError) return fromEngineError(error);
      throw error;
    }
  });

  app.get("/v1/events", (c) => {
    const after = c.req.query("after") ?? null;
    if (after !== null && after !== "" && !EVENT_ID.test(after)) {
      return problem("invalid_request", "after must be an event id.", {
        errors: [{ path: "after", message: "an event id" }],
      });
    }
    const raw = c.req.query("limit");
    const limit = raw === undefined ? 100 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return problem("invalid_request", "limit must be 1 to 500.", {
        errors: [{ path: "limit", message: "1 to 500" }],
      });
    }
    return c.json(deps.engine.eventsAfter(after || null, limit));
  });

  app.get("/v1/backups", async (c) =>
    c.json({ backups: await deps.backups.list(deps.engine.protectedBackups()) }),
  );

  app.get("/v1/config", (c) =>
    c.json({
      configHash: deps.configHash,
      config: configView(config, (text) => deps.redactor.redact(text)),
    }),
  );

  app.get("/v1/openapi.json", (c) => c.json(openApiDocument()));

  app.notFound(() => problem("not_found", "There is nothing at this path."));

  app.onError((error) => {
    deps.logger.error(`Request failed: ${deps.redactor.oneLine(error.message, 500)}`);
    return problem("internal");
  });

  return app;
}
