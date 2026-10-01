import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  classifyAddress,
  guardedLookup,
  HostPolicy,
  isAddressAllowed,
  isBlockedAddressError,
  isLocalHostname,
  type LookupAll,
} from "../src/index.js";

describe("classifyAddress", () => {
  it.each([
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.10", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["192.0.0.8", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.7", "reserved"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1%eth0", "link_local"],
    ["fd12:3456::1", "private"],
    ["fc00::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2001:0:4136:e378::1", "reserved"],
    ["[::1]", "loopback"],
  ])("classifies %s as %s", (address, kind) => {
    expect(classifyAddress(address)).toBe(kind);
  });

  it("judges IPv4 addresses embedded in IPv6 by the IPv4 host they reach", () => {
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("link_local");
    expect(classifyAddress("::ffff:0a00:0001")).toBe("private");
    expect(classifyAddress("64:ff9b::10.0.0.1")).toBe("private");
    expect(classifyAddress("64:ff9b::a9fe:a9fe")).toBe("link_local");
    expect(classifyAddress("2002:c0a8:0101::1")).toBe("private");
    expect(classifyAddress("2002:a9fe:a9fe::1")).toBe("link_local");
    expect(classifyAddress("::ffff:93.184.216.34")).toBe("public");
  });

  it("treats anything unparseable as reserved", () => {
    expect(classifyAddress("not-an-address")).toBe("reserved");
    expect(classifyAddress("300.1.1.1")).toBe("reserved");
    expect(classifyAddress("1:2:3:4:5:6:7:8:9")).toBe("reserved");
  });

  it("allows private networks only with consent, link-local never", () => {
    expect(isAddressAllowed("93.184.216.34", false)).toBe(true);
    expect(isAddressAllowed("10.0.0.5", false)).toBe(false);
    expect(isAddressAllowed("10.0.0.5", true)).toBe(true);
    expect(isAddressAllowed("127.0.0.1", true)).toBe(true);
    expect(isAddressAllowed("169.254.169.254", true)).toBe(false);
    expect(isAddressAllowed("224.0.0.1", true)).toBe(false);
    expect(isAddressAllowed("0.0.0.0", true)).toBe(false);
  });

  it.each([
    "localhost",
    "postgres",
    "api",
    "nas.local",
    "mail.internal",
    "Router.LAN.",
    "x.home.arpa",
  ])("%s exists only on a local network", (host) => {
    expect(isLocalHostname(host)).toBe(true);
  });
});

describe("HostPolicy", () => {
  const policy = new HostPolicy(["Forge.Example.Internal", "10.0.0.9"]);

  it("lets only the operator's hosts reach private networks, by exact name", () => {
    expect(policy.allowsPrivate("forge.example.internal")).toBe(true);
    expect(policy.allowsPrivate("other.example.internal")).toBe(false);
    expect(policy.refuseBeforeConnect("forge.example.internal")).toBeNull();
    expect(policy.refuseBeforeConnect("other.example.internal")).toBeInstanceOf(
      BlockedAddressError,
    );
    expect(policy.refuseBeforeConnect("postgres")).toBeInstanceOf(BlockedAddressError);
  });

  it("judges literal addresses before connecting", () => {
    expect(policy.refuseBeforeConnect("10.0.0.9")).toBeNull();
    expect(policy.refuseBeforeConnect("10.0.0.8")).toBeInstanceOf(BlockedAddressError);
    expect(policy.refuseBeforeConnect("[::1]")).toBeInstanceOf(BlockedAddressError);
    expect(policy.refuseBeforeConnect("169.254.169.254")).toBeInstanceOf(BlockedAddressError);
    expect(
      new HostPolicy(["169.254.169.254"]).refuseBeforeConnect("169.254.169.254"),
    ).toBeInstanceOf(BlockedAddressError);
    expect(policy.refuseBeforeConnect("api.github.com")).toBeNull();
  });
});

describe("guardedLookup", () => {
  const answers: Record<string, LookupAddress[]> = {
    "public.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ],
    "mixed.example.com": [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ],
    "forge.example.internal": [{ address: "10.0.0.9", family: 4 }],
    "metadata.example.com": [{ address: "169.254.169.254", family: 4 }],
    "rebind.example.com": [{ address: "127.0.0.1", family: 4 }],
  };
  const resolve: LookupAll = (host, callback) => {
    const found = answers[host];
    if (!found) {
      callback(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }),
        [],
      );
      return;
    }
    callback(null, found);
  };

  function lookup(host: string, allow: string[] = [], options: object = {}) {
    return new Promise<{ error: Error | null; address: unknown; family?: number }>((done) => {
      guardedLookup(new HostPolicy(allow), resolve)(
        host,
        options as never,
        ((error: Error | null, address: unknown, family?: number) =>
          done({ error, address, family })) as never,
      );
    });
  }

  it("hands out public addresses", async () => {
    expect(await lookup("public.example.com")).toEqual({
      error: null,
      address: "93.184.216.34",
      family: 4,
    });
    expect(await lookup("public.example.com", [], { family: 6 })).toMatchObject({
      address: "2606:2800:220:1::1",
    });
    const all = await lookup("public.example.com", [], { all: true });
    expect(all.address).toHaveLength(2);
  });

  it("refuses a name when ANY of its addresses is not allowed", async () => {
    const mixed = await lookup("mixed.example.com");
    expect(mixed.error).toBeInstanceOf(BlockedAddressError);
    expect(isBlockedAddressError({ cause: mixed.error })).toBe(true);
    expect((await lookup("rebind.example.com")).error).toBeInstanceOf(BlockedAddressError);
  });

  it("allows private addresses for the operator's hosts, never metadata addresses", async () => {
    expect((await lookup("forge.example.internal")).error).toBeInstanceOf(BlockedAddressError);
    expect(await lookup("forge.example.internal", ["forge.example.internal"])).toMatchObject({
      error: null,
      address: "10.0.0.9",
    });
    expect((await lookup("metadata.example.com", ["metadata.example.com"])).error).toBeInstanceOf(
      BlockedAddressError,
    );
  });

  it("passes DNS failures through", async () => {
    const result = await lookup("gone.example.com");
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});
