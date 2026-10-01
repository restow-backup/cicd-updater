import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import {
  createUpdaterClient,
  maintenanceViewOf,
  syncJournal,
  UpdaterProblemError,
  UpdaterUnavailableError,
} from "@restow-backup/cicd-updater";
import { createTokenVerifier } from "@restow-backup/cicd-updater/auth";
import { pool, ready } from "./db.ts";
import { APP_VERSION } from "./version.ts";

/**
 * The Notes API with the three jobs cicd-updater leaves to the app (docs/app-integration.md):
 *
 *   - /healthz answers readiness to everyone and the version only to the updater
 *     (createTokenVerifier): a public version tells attackers what is unpatched
 *   - /api/maintenance gives every user the run summary for the banner
 *   - /api/admin/* lets an admin schedule, cancel and acknowledge updates (the SDK
 *     client), and the journal is copied into the audit log exactly once (syncJournal)
 *
 * The demo's admin check is a bearer token from ADMIN_TOKEN. A real app uses its
 * own sign-in, allows only an installation admin, and asks for a recent strong
 * sign-in (step-up) before scheduling.
 */

const tokenFile = process.env.UPDATER_TOKEN_FILE ?? "/run/cicd-updater/token";
const updater = createUpdaterClient({ url: process.env.UPDATER_URL ?? "", tokenFile });
const verifier = createTokenVerifier({ tokenFile });
const adminToken = Buffer.from(process.env.ADMIN_TOKEN ?? "", "utf8");

function isAdmin(request: http.IncomingMessage): boolean {
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  const given = Buffer.from(match?.[1] ?? "", "utf8");
  return (
    adminToken.length >= 16 &&
    given.length === adminToken.length &&
    timingSafeEqual(given, adminToken)
  );
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16_384) {
      throw new Error("body too large");
    }
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Problems of the sidecar keep their status and code; "no sidecar" is 503. */
function sendError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof UpdaterProblemError) {
    send(response, error.status, { code: error.code, detail: error.problem.detail ?? null });
  } else if (error instanceof UpdaterUnavailableError) {
    send(response, 503, { code: "updater_unavailable", reason: error.reason });
  } else {
    send(response, 500, { code: "internal" });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://notes.local");
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "GET /healthz") {
      const database = await ready();
      const body: Record<string, unknown> = { status: database ? "ok" : "starting" };
      if (await verifier.isUpdater(request.headers.authorization)) {
        body.version = APP_VERSION;
      }
      send(response, database ? 200 : 503, body);
      return;
    }
    if (route === "GET /api/ping") {
      send(response, 200, { pong: true });
      return;
    }
    if (route === "GET /api/maintenance") {
      // Every signed-in user may read this; the browser polls it for the banner.
      send(response, 200, maintenanceViewOf(await updater.state().catch(() => null)));
      return;
    }
    if (!url.pathname.startsWith("/api/admin/")) {
      send(response, 404, { code: "not_found" });
      return;
    }
    if (!isAdmin(request)) {
      send(response, 401, { code: "unauthorized" });
      return;
    }
    const actor = { id: "admin", label: "Notes admin" };
    if (route === "GET /api/admin/updates") {
      const state = await updater.state({ fresh: true });
      const releases = state ? await updater.releases().catch(() => null) : null;
      send(response, 200, { state, releases });
      return;
    }
    if (route === "POST /api/admin/updates") {
      const body = await readJson(request);
      const view = await updater.schedule({
        version: String(body.version),
        leadSeconds: Number(body.leadSeconds ?? 300),
        requestedBy: actor,
        // What the admin saw is what gets installed.
        ...(typeof body.releaseSha256 === "string"
          ? { expect: { releaseSha256: body.releaseSha256 } }
          : {}),
      });
      send(response, 202, view);
      return;
    }
    const action = /^\/api\/admin\/updates\/([A-Za-z0-9_-]+)\/(cancel|acknowledge)$/.exec(
      url.pathname,
    );
    if (request.method === "POST" && action?.[1] && action[2]) {
      const view =
        action[2] === "cancel"
          ? await updater.cancel(action[1], actor)
          : await updater.acknowledge(action[1], actor);
      send(response, 200, view);
      return;
    }
    send(response, 404, { code: "not_found" });
  } catch (error) {
    sendError(response, error);
  }
});

/** Copy the updater's journal into the audit log, each event and the cursor in one transaction. */
async function ingestJournal(): Promise<void> {
  if (!(await updater.state())) {
    return;
  }
  await syncJournal({
    client: updater,
    loadCursor: async () =>
      (
        await pool.query<{ last_id: string }>(
          "SELECT last_id FROM updater_journal_cursor WHERE id = 1",
        )
      ).rows[0]?.last_id ?? null,
    ingest: async (event) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO audit_log (source, event_id, action, actor, detail, created_at) VALUES ('updater', $1, $2, $3, $4, $5) ON CONFLICT (source, event_id) DO NOTHING",
          [event.id, event.action, event.actor.label, JSON.stringify(event), event.at],
        );
        await client.query(
          "INSERT INTO updater_journal_cursor (id, last_id) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_id = $1",
          [event.id],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    onGap: async ({ after }) => {
      await pool.query(
        "INSERT INTO audit_log (source, event_id, action, detail, created_at) VALUES ('updater', $1, 'journal_gap', $2, now())",
        [`gap-${Date.now()}`, JSON.stringify({ after })],
      );
    },
  });
}

setInterval(() => {
  ingestJournal().catch((error: unknown) => {
    console.error(`journal sync: ${(error as Error).message}`);
  });
}, 30_000).unref();

server.listen(3000, () => {
  console.log(`notes api ${APP_VERSION} listening on :3000`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
}
