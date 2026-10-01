/**
 * Where a feed request may connect (design 7.3, rule 2). A feed URL may come
 * from an admin, so without a guard the feed check could be used to probe the
 * internal network (databases, other containers, the cloud metadata service,
 * the LAN) and read classified failures back.
 *
 * Only public unicast addresses are allowed. Hosts the operator named in
 * `allowPrivateHosts` may resolve to loopback and private networks, never to
 * link-local (cloud metadata), multicast or reserved addresses. IPv4 addresses
 * embedded in IPv6 (mapped, compatible, NAT64, 6to4) are judged by the IPv4
 * address they reach.
 *
 * The check runs inside the socket's own DNS lookup ({@link guardedLookup}),
 * so the address that was checked is the address that is connected to: a name
 * that resolves to something else a second later (DNS rebinding) gains nothing.
 *
 * Derived from Restow's address policy (Apache-2.0).
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "reserved"
  | "unspecified";

export const BLOCKED_ADDRESS_CODE = "BLOCKED_ADDRESS";

/** A connection the address policy refused. */
export class BlockedAddressError extends Error {
  readonly code = BLOCKED_ADDRESS_CODE;

  constructor(readonly host: string) {
    super(`connections to ${host} are not allowed: it is not a public address`);
    this.name = "BlockedAddressError";
  }
}

/** True for the policy's own refusal, however the socket layer wrapped it. */
export function isBlockedAddressError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === BLOCKED_ADDRESS_CODE) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function inRange(octets: readonly number[], network: readonly number[], prefix: number): boolean {
  let remaining = prefix;
  for (let index = 0; index < 4 && remaining > 0; index++) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if (((octets[index] ?? 0) & mask) !== ((network[index] ?? 0) & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

const IPV4_RANGES: ReadonlyArray<readonly [readonly number[], number, AddressClass]> = [
  [[0, 0, 0, 0], 8, "unspecified"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "private"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link_local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "reserved"],
  [[192, 0, 2, 0], 24, "reserved"],
  [[192, 88, 99, 0], 24, "reserved"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "reserved"],
  [[198, 51, 100, 0], 24, "reserved"],
  [[203, 0, 113, 0], 24, "reserved"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

function classifyIPv4(octets: readonly number[]): AddressClass {
  for (const [network, prefix, kind] of IPV4_RANGES) {
    if (inRange(octets, network, prefix)) {
      return kind;
    }
  }
  return "public";
}

/** Eight 16-bit groups, or null for text that is not an IPv6 address. */
function parseIPv6(input: string): number[] | null {
  let text = input.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && text.includes(".", lastColon)) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const [a, b, c, d] = v4;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return values.length === 8 && values.every((value) => !Number.isNaN(value)) ? values : null;
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function classifyIPv6(groups: readonly number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return g7 === 0 ? "unspecified" : "loopback";
  }
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (leadingZero && (g5 === 0xffff || g5 === 0)) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // NAT64 (64:ff9b::/96) reaches the embedded IPv4 host.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyIPv4(embeddedIPv4(g6, g7));
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) {
    return classifyIPv4(embeddedIPv4(g1, g2));
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return "link_local";
  }
  // Unique local (fc00::/7) and the deprecated site-local (fec0::/10).
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfec0) {
    return "private";
  }
  if ((g0 & 0xff00) === 0xff00) {
    return "multicast";
  }
  // Teredo (2001::/32) and documentation (2001:db8::/32).
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0x0db8)) {
    return "reserved";
  }
  // Only global unicast (2000::/3) is public.
  return (g0 & 0xe000) === 0x2000 ? "public" : "reserved";
}

/** Classify a literal IPv4 or IPv6 address; anything unparseable counts as reserved. */
export function classifyAddress(address: string): AddressClass {
  const bare = address.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(bare);
  if (v4) {
    return classifyIPv4(v4);
  }
  const v6 = parseIPv6(bare);
  return v6 ? classifyIPv6(v6) : "reserved";
}

/** Public addresses always; loopback and private networks only for hosts the operator allowed. */
export function isAddressAllowed(address: string, allowPrivate: boolean): boolean {
  const kind = classifyAddress(address);
  if (kind === "public") {
    return true;
  }
  return allowPrivate && (kind === "private" || kind === "loopback");
}

const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".localdomain",
];

/** Lowercase, without IPv6 brackets and without the root dot. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/** A name that exists only on a local network: `localhost`, single labels, local-only suffixes. */
export function isLocalHostname(host: string): boolean {
  const name = normalizeHost(host);
  return (
    name === "localhost" ||
    !name.includes(".") ||
    LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** Which hosts may reach private networks: the operator's exact, lowercase list. */
export class HostPolicy {
  private readonly privateHosts: ReadonlySet<string>;

  constructor(allowPrivateHosts: readonly string[] = []) {
    this.privateHosts = new Set(allowPrivateHosts.map(normalizeHost));
  }

  allowsPrivate(host: string): boolean {
    return this.privateHosts.has(normalizeHost(host));
  }

  /**
   * The checks that need no network, right before connecting: a literal address
   * never goes through the lookup, and a local-only name is refused without
   * asking the resolver. Returns the refusal, or null to go ahead.
   */
  refuseBeforeConnect(host: string): BlockedAddressError | null {
    const name = normalizeHost(host);
    const allowPrivate = this.allowsPrivate(name);
    if (isIP(name) !== 0) {
      return isAddressAllowed(name, allowPrivate) ? null : new BlockedAddressError(host);
    }
    if (!allowPrivate && isLocalHostname(name)) {
      return new BlockedAddressError(host);
    }
    return null;
  }
}

export type LookupAll = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemLookupAll: LookupAll = (hostname, callback) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, found) => {
    callback(error, Array.isArray(found) ? found : []);
  });
};

/**
 * A DNS lookup for `net.connect` / `tls.connect` that refuses to hand out a
 * disallowed address: when ANY address of the name is not allowed, the
 * connection fails with a {@link BlockedAddressError}.
 */
export function guardedLookup(
  policy: HostPolicy,
  resolve: LookupAll = systemLookupAll,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const allowPrivate = policy.allowsPrivate(hostname);
      const refused =
        addresses.length === 0 ||
        addresses.some((entry) => !isAddressAllowed(entry.address, allowPrivate));
      if (refused) {
        callback(new BlockedAddressError(hostname), "", 0);
        return;
      }
      const family = (options as { family?: number | string }).family;
      const wanted =
        family === 4 || family === "IPv4"
          ? addresses.filter((entry) => entry.family === 4)
          : family === 6 || family === "IPv6"
            ? addresses.filter((entry) => entry.family === 6)
            : addresses;
      if ((options as { all?: boolean }).all) {
        callback(null, wanted);
        return;
      }
      const [first] = wanted;
      if (!first) {
        callback(
          Object.assign(new Error(`no address of the requested family for ${hostname}`), {
            code: "ENOTFOUND",
          }),
          "",
          0,
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}
