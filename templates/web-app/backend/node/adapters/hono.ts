import { healthResponse } from "../health.js";
import type { Actor, UpdateRoutes } from "../updates.js";

/**
 * cicd-updater: Hono adapter for the update routes. Hono hands out the web-standard
 * request as `c.req.raw` and accepts a `Response`, so the adapter is a thin wrapper.
 *
 *   import { type Context, Hono } from "hono";
 *   import { updater } from "./updater.js";
 *   import { createUpdateRoutes } from "./updates.js";
 *   import { healthRoute, updatesMiddleware } from "./adapters/hono.js";
 *
 *   const app = new Hono();
 *   const routes = createUpdateRoutes({ updater, audit: writeAuditEntry });
 *   app.get("/healthz", healthRoute(() => db.ping()));
 *   app.use("/api/*", updatesMiddleware(routes, (c: Context) => actorFromSession(c)));
 *
 * Register it before a middleware that reads the body (`c.req.json()`), so the raw body
 * is still unread.
 */

interface HonoLikeContext {
  req: { raw: Request };
}

/** TODO(cicd-updater): `actorOf` maps your session (a cookie, `c.get("user")`, ...) to an Actor. */
export function updatesMiddleware<C extends HonoLikeContext>(
  routes: UpdateRoutes,
  actorOf: (c: C) => Promise<Actor | null> | Actor | null,
) {
  return async (c: C, next: () => Promise<void>): Promise<Response | undefined> => {
    if (routes.matches(new URL(c.req.raw.url).pathname)) {
      const answer = await routes.handle(c.req.raw, await actorOf(c));
      if (answer) {
        return answer;
      }
    }
    await next();
    return undefined;
  };
}

/** `GET /healthz`: readiness for everyone, the version only for the sidecar. */
export function healthRoute(ready: () => Promise<boolean>) {
  return (c: HonoLikeContext): Promise<Response> => healthResponse(c.req.raw, ready);
}
