import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  errorForTransport,
  FeedError,
  FeedHttp,
  guardedFetch,
  HostPolicy,
  type LookupAll,
  retryAtOf,
} from "../src/index.js";
import { bytes, FakeWeb, json } from "./fake-web.js";

const LIST = "https://forge.example.com/api/v1/repos/acme/notes/releases?limit=30";
const ASSET = "https://forge.example.com/attachments/1";

function client(web: FakeWeb, token: string | null = "secret-token-123456") {
  return new FeedHttp({
    policy: new HostPolicy(),
    token,
    tokenOrigin: "https://forge.example.com",
    authScheme: "token",
    fetch: web.fetch,
    now: () => Date.parse("2026-11-02T18:00:00Z"),
  });
}

async function failure(promise: Promise<unknown>): Promise<FeedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FeedError);
  return error as FeedError;
}

describe("release lists", () => {
  it("sends the token to the feed origin, a fixed user agent and nothing about the installation", async () => {
    const web = new FakeWeb().on(LIST, []);
    expect(await client(web).getJson(LIST)).toEqual([]);
    expect(web.requests).toEqual([
      {
        url: LIST,
        headers: {
          accept: "application/json",
          "user-agent": "cicd-updater-feed/1",
          authorization: "token secret-token-123456",
        },
      },
    ]);
  });

  it("follows same-origin redirects only", async () => {
    const moved = "https://forge.example.com/api/v1/repos/acme/notes-renamed/releases?limit=30";
    const web = new FakeWeb().redirect(LIST, moved, 301).on(moved, [{ ok: 1 }]);
    expect(await client(web).getJson(LIST)).toEqual([{ ok: 1 }]);
    expect(web.headersFor(moved)[0]?.authorization).toBe("token secret-token-123456");

    const elsewhere = new FakeWeb().redirect(LIST, "https://evil.example.com/releases");
    const error = await failure(client(elsewhere).getJson(LIST));
    expect(error.code).toBe("redirect");
    expect(elsewhere.requests.map((request) => request.url)).toEqual([LIST]);
  });

  it("gives up after three redirects and on redirects to http", async () => {
    const web = new FakeWeb();
    for (let hop = 0; hop < 5; hop++) {
      web.redirect(
        `https://forge.example.com/hop/${hop}`,
        `https://forge.example.com/hop/${hop + 1}`,
      );
    }
    expect((await failure(client(web).getJson("https://forge.example.com/hop/0"))).code).toBe(
      "redirect",
    );
    expect(web.requests).toHaveLength(4);
    const insecure = new FakeWeb().redirect(LIST, "http://forge.example.com/x");
    expect((await failure(client(insecure).getJson(LIST))).code).toBe("redirect");
  });

  it("refuses plain http and credentials in URLs before any request", async () => {
    const web = new FakeWeb();
    expect((await failure(client(web).getJson("http://forge.example.com/x"))).code).toBe(
      "redirect",
    );
    expect((await failure(client(web).getJson("https://u:p@forge.example.com/x"))).code).toBe(
      "redirect",
    );
    expect(web.requests).toEqual([]);
  });

  it("classifies answers", async () => {
    const cases: [Response, string, number | null][] = [
      [json({}, 401), "unauthorized", 401],
      [json({}, 403), "forbidden", 403],
      [json({}, 404), "not_found", 404],
      [json({}, 503), "server_error", 503],
      [json({}, 418), "invalid_response", 418],
      [bytes("<html>"), "invalid_response", 200],
    ];
    for (const [response, code, status] of cases) {
      const error = await failure(client(new FakeWeb().on(LIST, response)).getJson(LIST));
      expect([error.code, error.status]).toEqual([code, status]);
    }
    const notJson = await failure(client(new FakeWeb().on(LIST, bytes("<html>"))).getJson(LIST));
    expect(notJson.detail).toBe("not_json");
  });

  it("reports rate limits with the time they end", async () => {
    const limited = json({}, 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": "1793642400",
    });
    const error = await failure(client(new FakeWeb().on(LIST, limited)).getJson(LIST));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAt).toBe("2026-11-02T18:00:00.000Z");
    const retry = json({}, 429, { "retry-after": "120" });
    expect((await failure(client(new FakeWeb().on(LIST, retry)).getJson(LIST))).retryAt).toBe(
      "2026-11-02T18:02:00.000Z",
    );
    expect(retryAtOf(new Headers({ "retry-after": "Mon, 02 Nov 2026 19:00:00 GMT" }), 0)).toBe(
      "2026-11-02T19:00:00.000Z",
    );
  });

  it("refuses bodies over the cap, declared or streamed", async () => {
    const declared = new Response("[]", { headers: { "content-length": String(9 * 1024 * 1024) } });
    expect((await failure(client(new FakeWeb().on(LIST, declared)).getJson(LIST))).detail).toBe(
      "too_large",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index++) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
        controller.close();
      },
    });
    const streamed = new Response(stream);
    expect((await failure(client(new FakeWeb().on(LIST, streamed)).getJson(LIST))).detail).toBe(
      "too_large",
    );
  });
});

describe("assets", () => {
  it("follows a redirect to another origin without the token and never re-adds it", async () => {
    const cdn = "https://objects.cdn.example.net/asset?sig=abc";
    const back = "https://forge.example.com/attachments/1/again";
    const web = new FakeWeb().redirect(ASSET, cdn).redirect(cdn, back).on(back, bytes("{}"));
    const body = await client(web).getAsset(ASSET, 1024);
    expect(body.toString()).toBe("{}");
    expect(web.headersFor(ASSET)[0]?.authorization).toBe("token secret-token-123456");
    expect(web.headersFor(cdn)[0]).not.toHaveProperty("authorization");
    expect(web.headersFor(back)[0]).not.toHaveProperty("authorization");
  });

  it("never sends the token to an asset on another origin from the start", async () => {
    const other = "https://github.com/acme/notes/releases/download/v1.0.0/release.json";
    const web = new FakeWeb().on(other, bytes("{}"));
    await client(web).getAsset(other, 1024);
    expect(web.headersFor(other)[0]).not.toHaveProperty("authorization");
  });

  it("caps the asset size", async () => {
    const web = new FakeWeb().on(ASSET, bytes("x".repeat(2048)));
    expect((await failure(client(web).getAsset(ASSET, 1024))).detail).toBe("too_large");
  });
});

describe("transport failures", () => {
  it("tell nothing about what exists behind a name, but name TLS problems", () => {
    expect(errorForTransport(new BlockedAddressError("10.0.0.1"))).toMatchObject({
      code: "network",
      detail: null,
    });
    expect(
      errorForTransport(
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }),
      ),
    ).toMatchObject({
      code: "network",
      detail: null,
    });
    expect(
      errorForTransport(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" })),
    ).toMatchObject({
      code: "network",
      detail: "CERT_HAS_EXPIRED",
    });
    expect(errorForTransport(Object.assign(new Error("t"), { name: "TimeoutError" })).code).toBe(
      "timeout",
    );
  });
});

describe("guardedFetch against a real socket", () => {
  let port = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url, ua: request.headers["user-agent"] }));
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const resolve: LookupAll = (host, callback) => {
    if (host === "feed.example.com") {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    }
  };

  it("refuses a name that resolves to loopback (DNS rebinding) unless the operator allowed the host", async () => {
    const refused = guardedFetch({ policy: new HostPolicy(), allowInsecureHttp: true, resolve });
    const error = await refused(`http://feed.example.com:${port}/releases`, { headers: {} }).catch(
      (caught) => caught,
    );
    expect(errorForTransport(error)).toMatchObject({ code: "network", detail: null });

    const allowed = guardedFetch({
      policy: new HostPolicy(["feed.example.com"]),
      allowInsecureHttp: true,
      resolve,
    });
    const response = await allowed(`http://feed.example.com:${port}/releases`, {
      headers: { "user-agent": "t" },
    });
    expect(await response.json()).toEqual({ path: "/releases", ua: "t" });
  });

  it("refuses literal loopback addresses without resolving", async () => {
    const fetcher = guardedFetch({ policy: new HostPolicy(), allowInsecureHttp: true, resolve });
    await expect(fetcher(`http://127.0.0.1:${port}/`, { headers: {} })).rejects.toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it("refuses plain http outside tests", async () => {
    const fetcher = guardedFetch({ policy: new HostPolicy(["feed.example.com"]), resolve });
    await expect(fetcher(`http://feed.example.com:${port}/`, { headers: {} })).rejects.toThrow(
      /https/,
    );
  });
});
