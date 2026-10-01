/**
 * Semantic versions (https://semver.org, 2.0.0): parsing, precedence (spec item
 * 11), channels and the small range language of `requires.updater`.
 *
 * Input may carry a leading `v` and build metadata; both are ignored for
 * comparison. A *target* version (what a run installs, what `release.json`
 * names) is a plain version: no `v`, no build metadata.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The plain form `release.json` and image tags use. */
export const PLAIN_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/** Parse `1.2.3`, `v1.2.3-rc.1`, `1.2.3+build.5`; null for anything else. */
export function parseVersion(value: string): SemVer | null {
  if (typeof value !== "string" || value.length > 128) {
    return null;
  }
  const match = SEMVER.exec(value.trim());
  if (!match) {
    return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  // Numeric pre-release identifiers must not have leading zeros (spec item 9).
  if (prerelease.some((part) => /^0\d+$/.test(part))) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (numericA !== numericB) {
    return numericA ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Precedence of two parsed versions: negative when `a` is older than `b`. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) {
    return Math.sign(core);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A pre-release precedes its release.
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const order = compareIdentifiers(left, right);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

/** Compare two version strings; throws for strings that are not versions. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    throw new TypeError(`not a semantic version: ${!left ? a : b}`);
  }
  return compareSemVer(left, right);
}

/** Whether `candidate` is strictly newer than `running`; null when either is not a version. */
export function isNewer(running: string, candidate: string): boolean | null {
  const current = parseVersion(running);
  const next = parseVersion(candidate);
  if (!current || !next) {
    return null;
  }
  return compareSemVer(current, next) < 0;
}

/** Whether two strings name the same release (`v` prefix and build metadata ignored). */
export function sameVersion(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return false;
  }
  return compareSemVer(left, right) === 0;
}

/** The plain form of a version (`v1.2.3+meta` -> `1.2.3`); null when it is not a version. */
export function normalizeVersion(value: string): string | null {
  const parsed = parseVersion(value);
  if (!parsed) {
    return null;
  }
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length > 0 ? `${core}-${parsed.prerelease.join(".")}` : core;
}

/** Whether a string is a plain target version (no `v`, no build metadata). */
export function isPlainVersion(value: string): boolean {
  return PLAIN_VERSION_PATTERN.test(value) && parseVersion(value) !== null;
}

/** Whether the version has a pre-release part. */
export function isPrerelease(value: string): boolean {
  return (parseVersion(value)?.prerelease.length ?? 0) > 0;
}

/** The channel a version belongs to: `beta` exactly when it has a pre-release part. */
export function channelOf(version: string): "stable" | "beta" {
  return isPrerelease(version) ? "beta" : "stable";
}

/** Whether a channel offers a version: `stable` only releases, `beta` both. */
export function channelAllows(channel: "stable" | "beta", version: string): boolean {
  return channel === "beta" || !isPrerelease(version);
}

/** The range grammar of `requires.updater`: `>=X.Y.Z`, `^X.Y.Z` or `X.Y.Z`. */
export const RANGE_PATTERN = /^(>=|\^)?([0-9]+\.[0-9]+\.[0-9]+)$/;

/**
 * Whether `version` satisfies `range`:
 *
 *   `>=X.Y.Z`  at least X.Y.Z
 *   `^X.Y.Z`   at least X.Y.Z and below the next major (for 0.y: below the next minor)
 *   `X.Y.Z`    exactly X.Y.Z
 *
 * A pre-release satisfies a range only through its precedence (1.1.0-rc.1 is
 * below 1.1.0). Returns false for anything that does not parse.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const match = RANGE_PATTERN.exec(range.trim());
  const parsed = parseVersion(version);
  if (!match || !parsed) {
    return false;
  }
  const operator = match[1] ?? "";
  const base = parseVersion(match[2] as string) as SemVer;
  const order = compareSemVer(parsed, base);
  if (operator === "") {
    return order === 0;
  }
  if (order < 0) {
    return false;
  }
  if (operator === ">=") {
    return true;
  }
  // Caret: the next breaking version is excluded.
  const ceiling: SemVer =
    base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0, prerelease: [] }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] }
        : { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
  return compareSemVer(parsed, { ...ceiling, prerelease: ["0"] }) < 0;
}

/** Newest first, duplicates (same precedence) removed; strings that are not versions are dropped. */
export function sortVersionsDescending(versions: readonly string[]): string[] {
  const seen = new Set<string>();
  const parsed: { text: string; version: SemVer }[] = [];
  for (const text of versions) {
    const version = parseVersion(text);
    const key = normalizeVersion(text);
    if (!version || key === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    parsed.push({ text, version });
  }
  return parsed.sort((a, b) => compareSemVer(b.version, a.version)).map((entry) => entry.text);
}
