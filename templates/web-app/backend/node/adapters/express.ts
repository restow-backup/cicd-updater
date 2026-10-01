import type { IncomingMessage, ServerResponse } from "node:http";
import { health } from "../health.js";
import type { Actor, UpdateRoutes } from "../updates.js";

/**
 * cicd-updater: Express (4 and 5) and plain `node:http` adapter for the update routes.
 *
 *   import express from "express";
 *   import { updater } from "./updater.js";
 *   import { createUpdateRoutes } from "./updates.js";
 *   import { healthHandler, updatesMiddleware } from "./adapters/express.js";
 *
 *   const routes = createUpdateRoutes({ updater, audit: writeAuditEntry });
 *   app.get("/healthz", healthHandler(() => db.ping()));
 *   app.use(updatesMiddleware(routes, (req: express.Request) => actorFromSession(req)));
 *
 * The middleware only answers the paths of the routes and calls `next()` for everything
 * else. It works before or after `express.json()`. Mount it at the application, not under
 * a sub-path router, so that the paths match `basePath`.
 */

type NodeRequest = IncomingMessage & { body?: unknown; originalUrl?: string };

/** TODO(cicd-updater): `actorOf` maps your session (req.session, req.user, ...) to an Actor. */
export function updatesMiddleware<Req extends NodeRequest>(
  routes: UpdateRoutes,
  actorOf: (request: Req) => Promise<Actor | null> | Actor | null,
) {
  return (request: Req, response: ServerResponse, next: (error?: unknown) => void): void => {
    const pathname = new URL(request.originalUrl ?? request.url ?? "/", "http://app.invalid")
      .pathname;
    if (!routes.matches(pathname)) {
      next();
      return;
    }
    (async () => {
      const fetchRequest = await toFetchRequest(request);
      if (!fetchRequest) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ code: "payload_too_large" }));
        return;
      }
      const answer = await routes.handle(fetchRequest, await actorOf(request));
      if (!answer) {
        next();
        return;
      }
      response.statusCode = answer.status;
      answer.headers.forEach((value, name) => {
        response.setHeader(name, value);
      });
      response.end(Buffer.from(await answer.arrayBuffer()));
    })().catch(next);
  };
}

/** `GET /healthz`: readiness for everyone, the version only for the sidecar. */
export function healthHandler(ready: () => Promise<boolean>) {
  return (request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => {
    health(request.headers.authorization, ready)
      .then((answer) => {
        response.writeHead(answer.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(answer.body));
      })
      .catch(next);
  };
}

const MAX_BODY_BYTES = 16_384;

/**
 * Only the method, the path, the content type and the body matter to the routes; the
 * session stays in `req`. null: the body is larger than the routes accept.
 */
async function toFetchRequest(request: NodeRequest): Promise<Request | null> {
  const url = new URL(request.originalUrl ?? request.url ?? "/", "http://app.invalid");
  const method = (request.method ?? "GET").toUpperCase();
  const headers = new Headers();
  const type = request.headers["content-type"];
  if (type) {
    headers.set("content-type", type);
  }
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  if (request.body !== undefined) {
    // A body parser ran already. express.json() leaves {} for other content types; the
    // routes refuse those by their content type.
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    return new Request(url, { method, headers, body });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  return new Request(url, { method, headers, body: Buffer.concat(chunks).toString("utf8") });
}
