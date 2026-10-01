import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import type { FeedErrorCode } from "@cicd-updater/protocol";
import {
  guardedLookup,
  type HostPolicy,
  isBlockedAddressError,
  type LookupAll,
} from "./address-policy.js";

/**
 * HTTP for feeds (design 7.3): https only, every connection through the guarded
 * lookup and without pooling, redirects followed by hand, bodies read as
 * streams under a cap, and failures classified without telling what exists
 * behind a name.
 */

export const USER_AGENT = "cicd-updater-feed/1";
export const MAX_REDIRECTS = 3;
export const LIST_MAX_BYTES = 8 * 1024 * 1024;
export const LIST_TIMEOUT_MS = 10_000;
export const ASSET_TIMEOUT_MS = 15_000;

/** A feed failure (design 7.4). */
export class FeedError extends Error {
  constructor(
    readonly code: FeedErrorCode,
    readonly status: number | null = null,
    readonly retryAt: string | null = null,
    readonly detail: string | null = null,
  ) {
    super(`feed error: ${code}${status ? ` (HTTP ${status})` : ""}${detail ? ` ${detail}` : ""}`);
    this.name = "FeedError";
  }
}

export type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface GuardedFetchOptions {
  policy: HostPolicy;
  /** Tests only: plain http to a fake server. Never set from configuration. */
  allowInsecureHttp?: boolean;
  /** Tests only: a fake resolver. */
  resolve?: LookupAll;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * `fetch` over Node's own client, so the socket's DNS lookup can refuse what the
 * policy does not allow. It never follows a redirect and never pools connections.
 */
export function guardedFetch(options: GuardedFetchOptions): FetchLike {
  const lookup = guardedLookup(options.policy, options.resolve);
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(input);
      } catch (error) {
        reject(error);
        return;
      }
      const plain = url.protocol === "http:" && options.allowInsecureHttp === true;
      if (url.protocol !== "https:" && !plain) {
        reject(new TypeError("only https is fetched"));
        return;
      }
      const refused = options.policy.refuseBeforeConnect(url.hostname);
      if (refused) {
        reject(refused);
        return;
      }
      const request = (plain ? http : https).request(
        url,
        {
          method: init.method ?? "GET",
          headers: init.headers,
          lookup,
          // A fresh connection each time: a pooled socket would skip the guarded lookup.
          agent: false,
          signal: init.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
              headers.append(name, item);
            }
          }
          const status = incoming.statusCode ?? 0;
          const body = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
          if (body === null) {
            incoming.resume();
          }
          try {
            resolve(new Response(body, { status, headers }));
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      request.on("error", (error) => reject(error));
      request.end();
    });
}

/** When a rate limit ends, from `Retry-After` or `X-RateLimit-Reset`. */
export function retryAtOf(headers: Headers, nowMs: number): string | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return new Date(nowMs + seconds * 1000).toISOString();
    }
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) {
      return new Date(at).toISOString();
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  return null;
}

/** The feed error for a non-success answer. */
export function errorForStatus(
  response: Pick<Response, "status" | "headers">,
  nowMs: number,
): FeedError {
  const { status, headers } = response;
  if (status === 401) {
    return new FeedError("unauthorized", status);
  }
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) {
    return new FeedError("rate_limited", status, retryAtOf(headers, nowMs));
  }
  if (status === 403) {
    return new FeedError("forbidden", status);
  }
  if (status === 404) {
    return new FeedError("not_found", status);
  }
  if (status >= 500) {
    return new FeedError("server_error", status);
  }
  return new FeedError("invalid_response", status, null, "status");
}

const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

/**
 * A transport failure. A refused address, a DNS failure and a failed connection
 * all read `network` without detail; only a TLS problem of a host that was
 * allowed and answered is named. Never the URL.
 */
export function errorForTransport(error: unknown): FeedError {
  if (error instanceof FeedError) {
    return error;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new FeedError("timeout");
  }
  if (isBlockedAddressError(error)) {
    return new FeedError("network");
  }
  const candidate = (error as { cause?: { code?: unknown }; code?: unknown } | null) ?? null;
  const code =
    typeof candidate?.cause?.code === "string"
      ? candidate.cause.code
      : typeof candidate?.code === "string"
        ? candidate.code
        : null;
  return new FeedError("network", null, null, code && TLS_CODE.test(code) ? code : null);
}

/** The body as bytes, read as a stream and given up past the cap (declared or not). */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new FeedError("invalid_response", response.status, null, "too_large");
  }
  if (!response.body) {
    return Buffer.alloc(0);
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
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new FeedError("invalid_response", response.status, null, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export interface FeedClientOptions {
  policy: HostPolicy;
  /** Sent as an `Authorization` header to `tokenOrigin` only. */
  token?: string | null;
  /** The origin the token was issued for (the feed's own origin). */
  tokenOrigin?: string | null;
  /** How the token is sent: `token <t>` (Gitea/Forgejo) or `Bearer <t>` (GitHub, GitLab). */
  authScheme?: "token" | "Bearer";
  /** Replaces the guarded transport (tests). */
  fetch?: FetchLike;
  /** Tests only: allow http. */
  allowInsecureHttp?: boolean;
  now?: () => number;
}

export interface RequestOptions {
  accept: string;
  maxBytes: number;
  timeoutMs: number;
  /** Release lists: only same-origin redirects. Assets: other origins allowed, token dropped. */
  crossOriginRedirects: boolean;
}

/** One feed client: transport, token and policy. */
export class FeedHttp {
  private readonly fetcher: FetchLike;

  constructor(private readonly options: FeedClientOptions) {
    this.fetcher =
      options.fetch ??
      guardedFetch({ policy: options.policy, allowInsecureHttp: options.allowInsecureHttp });
  }

  private secure(url: URL): boolean {
    return (
      url.protocol === "https:" ||
      (this.options.allowInsecureHttp === true && url.protocol === "http:")
    );
  }

  async get(
    input: string,
    request: RequestOptions,
  ): Promise<{ body: Buffer; url: string; status: number }> {
    const nowMs = (this.options.now ?? Date.now)();
    let current: URL;
    try {
      current = new URL(input);
    } catch {
      throw new FeedError("invalid_response", null, null, "url");
    }
    if (!this.secure(current) || current.username || current.password) {
      throw new FeedError("redirect", null, null, "not_https");
    }
    const firstOrigin = current.origin;
    const tokenOrigin = this.options.tokenOrigin ?? firstOrigin;
    let tokenAllowed = true;
    const signal = AbortSignal.timeout(request.timeoutMs);
    try {
      for (let hop = 0; ; hop++) {
        if (current.origin !== tokenOrigin) {
          // Once the request left the token's origin, the token is gone for good.
          tokenAllowed = false;
        }
        const headers: Record<string, string> = {
          accept: request.accept,
          "user-agent": USER_AGENT,
        };
        if (this.options.token && tokenAllowed) {
          headers.authorization = `${this.options.authScheme ?? "Bearer"} ${this.options.token}`;
        }
        const response = await this.fetcher(current.toString(), { method: "GET", headers, signal });
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          const location = response.headers.get("location");
          let next: URL | null = null;
          try {
            next = location ? new URL(location, current) : null;
          } catch {
            next = null;
          }
          if (
            !next ||
            hop >= MAX_REDIRECTS ||
            !this.secure(next) ||
            next.username ||
            next.password ||
            (!request.crossOriginRedirects && next.origin !== firstOrigin)
          ) {
            throw new FeedError("redirect", response.status);
          }
          current = next;
          continue;
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw errorForStatus(response, nowMs);
        }
        const body = await readCapped(response, request.maxBytes);
        return { body, url: current.toString(), status: response.status };
      }
    } catch (error) {
      throw errorForTransport(error);
    }
  }

  /** A JSON document (release list, feed index); same-origin redirects only. */
  async getJson(
    url: string,
    maxBytes = LIST_MAX_BYTES,
    timeoutMs = LIST_TIMEOUT_MS,
  ): Promise<unknown> {
    const { body, status } = await this.get(url, {
      accept: "application/json",
      maxBytes,
      timeoutMs,
      crossOriginRedirects: false,
    });
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new FeedError("invalid_response", status, null, "not_json");
    }
  }

  /** An asset (release.json, bundle); redirects to other origins allowed, the token dropped there. */
  async getAsset(
    url: string,
    maxBytes: number,
    accept = "application/octet-stream, application/json",
    timeoutMs = ASSET_TIMEOUT_MS,
  ): Promise<Buffer> {
    const { body } = await this.get(url, {
      accept,
      maxBytes,
      timeoutMs,
      crossOriginRedirects: true,
    });
    return body;
  }
}
