import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeEnvValue,
  assignedKey,
  assignedValue,
  captureKeys,
  EnvFile,
  EnvFileError,
  envValueOf,
  parseEnvLines,
  renderEnvLines,
  restoreKeys,
  sameCapture,
  setKeys,
} from "../src/index.js";

const KEYS = ["APP_IMAGE", "WEB_IMAGE"] as const;
const NEW = {
  APP_IMAGE: "ghcr.io/x/notes:0.2.0",
  WEB_IMAGE: "ghcr.io/x/notes-web:0.2.0@sha256:abc",
};

/** Set both keys, then restore: the text must come back byte for byte. */
function roundTrip(original: string): string {
  const captured = captureKeys(original, KEYS);
  const changed = setKeys(original, NEW);
  expect(changed).not.toBe(original);
  return restoreKeys(changed, captured);
}

describe("line model", () => {
  it.each([
    [""],
    ["A=1"],
    ["A=1\n"],
    ["A=1\nB=2"],
    ["A=1\r\nB=2\r\n"],
    ["A=1\r\nB=2"],
    ["\n\n"],
    ["A=1\n\r\nB=2\n"],
    ["# c\n\nA=1\n"],
  ])("parses and renders %j unchanged", (text) => {
    expect(renderEnvLines(parseEnvLines(text))).toBe(text);
  });

  it("recognises assignments, not comments", () => {
    expect(assignedKey("APP_IMAGE=x")).toBe("APP_IMAGE");
    expect(assignedKey("  export APP_IMAGE = x")).toBe("APP_IMAGE");
    expect(assignedKey("# APP_IMAGE=x")).toBeNull();
    expect(assignedKey("just text")).toBeNull();
    expect(assignedKey("")).toBeNull();
  });

  it("parses values with quotes and inline comments", () => {
    expect(assignedValue("A=plain")).toBe("plain");
    expect(assignedValue('A="quoted value" # comment')).toBe("quoted value");
    expect(assignedValue("A='single # not a comment'")).toBe("single # not a comment");
    expect(assignedValue("A=value # comment")).toBe("value");
    expect(assignedValue("A=")).toBe("");
    expect(assignedValue('A="esc \\" quote"')).toBe('esc " quote');
    expect(assignedValue("A=with#hash")).toBe("with#hash");
  });
});

describe("setKeys / restoreKeys", () => {
  it("replaces existing assignments in place and keeps every other line byte for byte", () => {
    const original = [
      "# header comment",
      "",
      "POSTGRES_PASSWORD=pw pw with space",
      "APP_IMAGE=ghcr.io/x/notes:0.1.0",
      "  # indented comment",
      'WEB_IMAGE="ghcr.io/x/notes-web:0.1.0" # pinned',
      "LAST=1",
      "",
    ].join("\n");
    expect(setKeys(original, NEW)).toBe(
      [
        "# header comment",
        "",
        "POSTGRES_PASSWORD=pw pw with space",
        "APP_IMAGE=ghcr.io/x/notes:0.2.0",
        "  # indented comment",
        "WEB_IMAGE=ghcr.io/x/notes-web:0.2.0@sha256:abc",
        "LAST=1",
        "",
      ].join("\n"),
    );
    expect(roundTrip(original)).toBe(original);
  });

  it("appends absent keys and restores them to absent", () => {
    const original = "A=1\n# c\nB=2\n";
    expect(setKeys(original, NEW)).toBe(
      `${original}APP_IMAGE=${NEW.APP_IMAGE}\nWEB_IMAGE=${NEW.WEB_IMAGE}\n`,
    );
    expect(roundTrip(original)).toBe(original);
  });

  it("restores an empty existing value as empty (not as absent)", () => {
    const original = "APP_IMAGE=\nWEB_IMAGE=\nA=1\n";
    expect(captureKeys(original, KEYS).APP_IMAGE).toEqual({
      present: true,
      line: "APP_IMAGE=",
      value: "",
    });
    expect(roundTrip(original)).toBe(original);
  });

  it("handles CRLF, a missing final newline and an empty file", () => {
    const crlf = "# c\r\nA=1\r\nAPP_IMAGE=old\r\nB=2\r\n";
    expect(setKeys(crlf, NEW)).toBe(
      `# c\r\nA=1\r\nAPP_IMAGE=${NEW.APP_IMAGE}\r\nB=2\r\nWEB_IMAGE=${NEW.WEB_IMAGE}\r\n`,
    );
    expect(roundTrip(crlf)).toBe(crlf);
    const open = "A=1\nB=2";
    expect(setKeys(open, NEW).endsWith(NEW.WEB_IMAGE)).toBe(true);
    expect(roundTrip(open)).toBe(open);
    expect(roundTrip("")).toBe("");
    expect(roundTrip("A=1\r\nB=2")).toBe("A=1\r\nB=2");
    const withKey = "A=1\nAPP_IMAGE=old";
    expect(setKeys(withKey, { APP_IMAGE: "x:1" })).toBe("A=1\nAPP_IMAGE=x:1");
  });

  it("replaces the last of several assignments (the one Compose uses) and restores it", () => {
    const original = "APP_IMAGE=first\nA=1\nAPP_IMAGE=second\n";
    const changed = setKeys(original, { APP_IMAGE: "x:2" });
    expect(changed).toBe("APP_IMAGE=first\nA=1\nAPP_IMAGE=x:2\n");
    expect(restoreKeys(changed, captureKeys(original, ["APP_IMAGE"]))).toBe(original);
  });

  it("keeps an export prefix and ignores commented-out assignments", () => {
    expect(setKeys("export APP_IMAGE=old\n", { APP_IMAGE: "x:1" })).toBe("export APP_IMAGE=x:1\n");
    const original = "# APP_IMAGE=old\nA=1\n";
    const changed = setKeys(original, { APP_IMAGE: "x:1" });
    expect(changed).toBe("# APP_IMAGE=old\nA=1\nAPP_IMAGE=x:1\n");
    expect(restoreKeys(changed, captureKeys(original, ["APP_IMAGE"]))).toBe(original);
  });

  it("re-adds a key that was removed in the meantime", () => {
    const captured = captureKeys("APP_IMAGE=old\nA=1\n", ["APP_IMAGE"]);
    expect(restoreKeys("A=1\n", captured)).toBe("A=1\nAPP_IMAGE=old\n");
  });

  it("rejects values and names that are not plain", () => {
    for (const value of ["a b", "a$b", 'a"b', "a`b`", "", "a\nb", "x#y", "-x", `$${"{X}"}`]) {
      expect(() => assertSafeEnvValue("APP_IMAGE", value), value).toThrow(EnvFileError);
    }
    expect(() => setKeys("", { "bad-name": "x" })).toThrow(EnvFileError);
    expect(() =>
      assertSafeEnvValue("APP_IMAGE", `ghcr.io/x/y:1.2.3-rc.1@sha256:${"a".repeat(64)}`),
    ).not.toThrow();
    expect(() => assertSafeEnvValue("APP_VERSION", "1.2.3")).not.toThrow();
  });

  it("reads the last assignment and compares captures", () => {
    expect(envValueOf("A=1\nA=2\n", "A")).toBe("2");
    expect(envValueOf("A=1\n", "B")).toBeNull();
    const a = captureKeys("APP_IMAGE=x\n", ["APP_IMAGE", "WEB_IMAGE"]);
    expect(sameCapture(a, captureKeys("APP_IMAGE=x\n", ["APP_IMAGE", "WEB_IMAGE"]))).toEqual([]);
    expect(sameCapture(a, captureKeys('APP_IMAGE="x"\n', ["APP_IMAGE", "WEB_IMAGE"]))).toEqual([
      "APP_IMAGE",
    ]);
    expect(
      sameCapture(a, captureKeys("APP_IMAGE=x\nWEB_IMAGE=y\n", ["APP_IMAGE", "WEB_IMAGE"])),
    ).toEqual(["WEB_IMAGE"]);
  });
});

describe("byte-exactness (property)", () => {
  const lineText = fc.oneof(
    fc.constantFrom(
      "",
      "# comment",
      "  # indented",
      "A=1",
      "export B=two",
      'C="quoted # x"',
      "D='single'",
      "APP_IMAGE=old:1",
      'WEB_IMAGE="w:1" # c',
      "OTHER_IMAGE=keep",
    ),
    fc.string({
      unit: fc.constantFrom("a", "B", "=", " ", "#", "'", '"', "_", "x", "1"),
      maxLength: 12,
    }),
  );
  const fileText = fc
    .tuple(
      fc.array(fc.tuple(lineText, fc.constantFrom("\n", "\r\n")), { maxLength: 12 }),
      fc.boolean(),
    )
    .map(([lines, finalNewline]) => {
      const text = lines.map(([line, eol]) => line + eol).join("");
      return finalNewline ? text : text.replace(/\r?\n$/, "");
    });

  it("set then restore returns every file exactly", () => {
    fc.assert(
      fc.property(fileText, (original) => {
        const captured = captureKeys(original, KEYS);
        const changed = setKeys(original, NEW);
        expect(captureKeys(changed, KEYS).APP_IMAGE?.value).toBe(NEW.APP_IMAGE);
        expect(restoreKeys(changed, captured)).toBe(original);
      }),
      { numRuns: 300 },
    );
  });

  it("only the lines of the written keys change", () => {
    fc.assert(
      fc.property(fileText, (original) => {
        const before = parseEnvLines(original).filter(
          (line) => !KEYS.includes(assignedKey(line.text) as never),
        );
        const after = parseEnvLines(setKeys(original, NEW)).filter(
          (line) => !KEYS.includes(assignedKey(line.text) as never),
        );
        expect(after.map((line) => line.text)).toEqual(before.map((line) => line.text));
      }),
      { numRuns: 300 },
    );
  });
});

describe("EnvFile", () => {
  let dir: string;
  let file: EnvFile;
  let target: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-env-"));
    target = path.join(dir, ".env");
    file = new EnvFile(target, ["APP_IMAGE", "WEB_IMAGE"]);
  });

  afterEach(async () => {
    await fs.chmod(dir, 0o700).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("applies and restores atomically, keeping the mode and leaving no temporary file", async () => {
    const original = "# c\nPOSTGRES_PASSWORD=pw\nAPP_IMAGE=old:1\n";
    await fs.writeFile(target, original);
    await fs.chmod(target, 0o640);
    const captured = await file.capture();
    await file.apply(NEW);
    expect(await fs.readFile(target, "utf8")).toContain(`APP_IMAGE=${NEW.APP_IMAGE}`);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    await file.restore(captured);
    expect(await fs.readFile(target, "utf8")).toBe(original);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect(await fs.readdir(dir)).toEqual([".env"]);
  });

  it("does not rewrite the file when nothing changes, and follows a symlink", async () => {
    await fs.writeFile(target, "APP_IMAGE=x:1\n");
    const before = (await fs.stat(target)).ino;
    await file.apply({ APP_IMAGE: "x:1" });
    expect((await fs.stat(target)).ino).toBe(before);
    const real = path.join(dir, "real.env");
    await fs.writeFile(real, "A=1\n");
    const link = path.join(dir, "link.env");
    await fs.symlink(real, link);
    await new EnvFile(link, ["APP_IMAGE"]).apply({ APP_IMAGE: "x:1" });
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, "utf8")).toBe("A=1\nAPP_IMAGE=x:1\n");
  });

  it("writes and restores only its writable keys, never anything else", async () => {
    const original = "APP_IMAGE=a:1\nUPDATER_IMAGE=pinned\nPOSTGRES_PASSWORD=pw\n";
    await fs.writeFile(target, original);
    const attempts: Record<string, string>[] = [
      { UPDATER_IMAGE: "evil:1" },
      { APP_IMAGE: "b:2", POSTGRES_PASSWORD: "x" },
    ];
    for (const assignments of attempts) {
      await expect(file.apply(assignments)).rejects.toMatchObject({ reason: "invalid_setting" });
    }
    await expect(
      file.restore({ UPDATER_IMAGE: { present: true, line: "UPDATER_IMAGE=x" } }),
    ).rejects.toMatchObject({
      reason: "invalid_setting",
    });
    expect(await fs.readFile(target, "utf8")).toBe(original);
  });

  it("reports a missing file and, unless root, an unwritable file and directory", async () => {
    await expect(file.read()).rejects.toMatchObject({ reason: "missing" });
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "missing" });
    await fs.writeFile(target, "A=1\n");
    await expect(file.assertWritable()).resolves.toBeUndefined();
    if (process.getuid?.() === 0) {
      return;
    }
    await fs.chmod(target, 0o400);
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "unwritable" });
    await fs.chmod(target, 0o600);
    await fs.chmod(dir, 0o500);
    await expect(file.assertWritable()).rejects.toMatchObject({ reason: "unwritable" });
  });
});
