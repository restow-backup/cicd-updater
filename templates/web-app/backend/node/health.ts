import { createTokenVerifier } from "@restow-backup/cicd-updater/auth";
import { UPDATER_TOKEN_FILE } from "./updater.js";

/**
 * cicd-updater: the health endpoint the sidecar polls after an update
 * (docs/app-integration.md, section 6).
 *
 * - Readiness for everyone: 200 when ready, 503 while starting.
 * - The version only for the sidecar: it sends `Authorization: Bearer <shared token>`
 *   (`hooks.health.http.sendToken: true`, the default). A public version number tells an
 *   attacker which known vulnerability is still open.
 *
 * updater.yaml:  hooks.health.http.url: http://api:3000/healthz
 *                hooks.health.http.versionJsonPath: $.version
 */

/**
 * The app's version, baked into the image at build time. The release side's build action
 * passes the plain version as the build argument VERSION; your Dockerfile turns it into an
 * environment variable:
 *
 *   ARG VERSION=0.0.0-dev
 *   ENV APP_VERSION=${VERSION}
 */
export const APP_VERSION = (process.env.APP_VERSION ?? "0.0.0-dev").replace(/^v/, "");

const verifier = createTokenVerifier({ tokenFile: UPDATER_TOKEN_FILE });

export interface HealthAnswer {
  status: 200 | 503;
  body: { status: "ok" | "starting"; version?: string };
}

/**
 * TODO(cicd-updater): pass what "ready" means for your app, for example a database ping.
 * Check only what the first start group provides (docs/hooks.md, health).
 */
export async function health(
  authorization: string | null | undefined,
  ready: () => Promise<boolean>,
): Promise<HealthAnswer> {
  const ok = await ready().catch(() => false);
  const answer: HealthAnswer = {
    status: ok ? 200 : 503,
    body: { status: ok ? "ok" : "starting" },
  };
  if (await verifier.isUpdater(authorization)) {
    answer.body.version = APP_VERSION;
  }
  return answer;
}

/** The same as a web-standard handler: `GET /healthz`. */
export async function healthResponse(
  request: Request,
  ready: () => Promise<boolean>,
): Promise<Response> {
  const answer = await health(request.headers.get("authorization"), ready);
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
