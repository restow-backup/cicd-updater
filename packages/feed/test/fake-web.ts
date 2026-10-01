import type { FetchLike } from "../src/index.js";

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/** A scripted web for feed tests: exact URLs answer, everything else is a network failure. */
export class FakeWeb {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, Handler>();

  on(url: string, handler: Handler | Response | unknown): this {
    if (typeof handler === "function") {
      this.routes.set(url, handler as Handler);
    } else if (handler instanceof Response) {
      // Single use: a cloned (teed) body could never be cancelled on its own.
      let used = false;
      this.routes.set(url, () => {
        if (used) {
          throw new Error(`the scripted response for ${url} was already used`);
        }
        used = true;
        return handler;
      });
    } else {
      this.routes.set(url, () => json(handler));
    }
    return this;
  }

  redirect(from: string, to: string, status = 302): this {
    return this.on(from, () => new Response(null, { status, headers: { location: to } }));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const request = { url, headers: { ...init.headers } };
    this.requests.push(request);
    const handler = this.routes.get(url);
    if (!handler) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }
    return await handler(request);
  };

  headersFor(url: string): Record<string, string>[] {
    return this.requests.filter((request) => request.url === url).map((request) => request.headers);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function bytes(body: string | Uint8Array, status = 200): Response {
  return new Response(typeof body === "string" ? new TextEncoder().encode(body) : body, { status });
}
