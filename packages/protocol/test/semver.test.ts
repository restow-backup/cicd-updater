import { describe, expect, it } from "vitest";
import {
  channelAllows,
  channelOf,
  compareVersions,
  isNewer,
  isPlainVersion,
  normalizeVersion,
  parseVersion,
  sameVersion,
  satisfiesRange,
  sortVersionsDescending,
} from "../src/index.js";

describe("semver", () => {
  it("parses versions with and without a leading v", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseVersion("v1.2.3-rc.1+build5")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ["rc", "1"],
    });
    for (const bad of ["1.2", "latest", "", "01.2.3", "1.2.3-01", "1.2.3-", "1.2.3+"]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
  });

  it("orders versions by precedence (spec item 11)", () => {
    const order = [
      "0.1.0",
      "0.1.1",
      "0.2.0-alpha",
      "0.2.0-alpha.1",
      "0.2.0-alpha.beta",
      "0.2.0-beta",
      "0.2.0-beta.2",
      "0.2.0-beta.11",
      "0.2.0-rc.1",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let index = 1; index < order.length; index++) {
      const left = order[index - 1] as string;
      const right = order[index] as string;
      expect(compareVersions(left, right), `${left} < ${right}`).toBeLessThan(0);
      expect(compareVersions(right, left)).toBeGreaterThan(0);
    }
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(() => compareVersions("dev", "1.0.0")).toThrow(TypeError);
  });

  it("isNewer is strict and null for non-versions", () => {
    expect(isNewer("0.1.0", "0.1.1")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "0.1.9")).toBe(false);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(false);
    expect(isNewer("dev", "1.0.0")).toBeNull();
    expect(isNewer("1.0.0", "next")).toBeNull();
  });

  it("normalizes and recognizes plain target versions", () => {
    expect(normalizeVersion("v0.2.0")).toBe("0.2.0");
    expect(normalizeVersion(" 0.2.0-rc.1+x ")).toBe("0.2.0-rc.1");
    expect(normalizeVersion("0.2")).toBeNull();
    expect(isPlainVersion("1.4.0")).toBe(true);
    expect(isPlainVersion("1.4.0-rc.1")).toBe(true);
    for (const bad of ["v1.4.0", "1.4.0+build", "../etc", "1.4.0/../x", " 1.4.0"]) {
      expect(isPlainVersion(bad), bad).toBe(false);
    }
  });

  it("sameVersion ignores the v prefix and build metadata", () => {
    expect(sameVersion("v0.2.0", "0.2.0")).toBe(true);
    expect(sameVersion("0.2.0+abc", "0.2.0")).toBe(true);
    expect(sameVersion("0.2.0", "0.2.1")).toBe(false);
    expect(sameVersion("dev", "0.2.0")).toBe(false);
  });

  it("derives channels from the pre-release part", () => {
    expect(channelOf("1.0.0")).toBe("stable");
    expect(channelOf("1.0.0-beta.1")).toBe("beta");
    expect(channelAllows("stable", "1.0.0")).toBe(true);
    expect(channelAllows("stable", "1.1.0-rc.1")).toBe(false);
    expect(channelAllows("beta", "1.1.0-rc.1")).toBe(true);
    expect(channelAllows("beta", "1.1.0")).toBe(true);
  });

  it("evaluates the ranges of requires.updater", () => {
    const cases: [string, string, boolean][] = [
      ["1.0.0", ">=1.0.0", true],
      ["0.9.9", ">=1.0.0", false],
      ["2.5.0", ">=1.0.0", true],
      ["1.0.0-rc.1", ">=1.0.0", false],
      ["1.4.2", "^1.2.0", true],
      ["1.1.9", "^1.2.0", false],
      ["2.0.0", "^1.2.0", false],
      ["2.0.0-rc.1", "^1.2.0", false],
      ["0.2.5", "^0.2.1", true],
      ["0.3.0", "^0.2.1", false],
      ["0.0.3", "^0.0.3", true],
      ["0.0.4", "^0.0.3", false],
      ["1.2.3", "1.2.3", true],
      ["1.2.4", "1.2.3", false],
      ["1.2.3", "~1.2.3", false],
      ["1.2.3", ">1.2.0", false],
      ["dev", ">=1.0.0", false],
    ];
    for (const [version, range, expected] of cases) {
      expect(satisfiesRange(version, range), `${version} ${range}`).toBe(expected);
    }
  });

  it("sorts newest first and removes duplicates", () => {
    expect(
      sortVersionsDescending(["1.0.0", "v1.2.0", "1.2.0", "1.1.0-rc.1", "x", "1.1.0"]),
    ).toEqual(["v1.2.0", "1.1.0", "1.1.0-rc.1", "1.0.0"]);
  });
});
