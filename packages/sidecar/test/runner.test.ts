import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { Redactor } from "@cicd-updater/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExecutable, LocalRunner } from "../src/index.js";

/** A stand-in `docker` that echoes what it was given. */
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
  args) shift; for a in "$@"; do printf '%s\\n' "$a"; done ;;
  env) env | sort ;;
  cwd) pwd ;;
  cat) cat ;;
  fail) echo "boom Authorization: Bearer abcdefghijklmnop" >&2; echo "to stdout"; exit 3 ;;
  sleep) sleep 30 ;;
  big) head -c 100000 /dev/zero | tr '\\0' 'x' ;;
  *) echo "unknown" >&2; exit 64 ;;
esac
`;

let dir: string;
let bin: string;
let cwd: string;
const redactor = new Redactor();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-runner-"));
  bin = path.join(dir, "bin");
  cwd = path.join(dir, "project");
  await fs.mkdir(bin);
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function runner(
  env: Record<string, string | undefined> = {},
  fixedEnv: Record<string, string> = {},
): LocalRunner {
  return new LocalRunner({
    redactor,
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/updater", ...env },
    fixedEnv,
  });
}

describe("LocalRunner", () => {
  it("finds its programs in PATH and reports missing ones", async () => {
    expect(runner().available("docker")).toBe(true);
    expect(findExecutable("docker", bin)).toBe(path.join(bin, "docker"));
    const missing = new LocalRunner({ redactor, cwd, env: { PATH: "/nonexistent" } });
    expect(missing.available("cosign")).toBe(false);
    expect((await missing.run({ argv: ["cosign", "version"], timeoutMs: 1000 })).exitCode).toBe(
      127,
    );
    await expect(
      runner().run({ argv: ["sh" as never, "-c", "true"], timeoutMs: 1000 }),
    ).rejects.toThrow(/cannot be run/);
  });

  it("passes arguments exactly, without a shell", async () => {
    const hostile = [
      "a b",
      "x; touch pwned",
      "$(touch pwned)",
      "`touch pwned`",
      "'quoted'",
      '"dq"',
      "*",
      "line\nbreak",
      "--flag=value",
    ];
    const result = await runner().run({ argv: ["docker", "args", ...hostile], timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${hostile.join("\n")}\n`);
    await expect(fs.access(path.join(cwd, "pwned"))).rejects.toThrow();
    await expect(
      runner().run({ argv: ["docker", "args", "a\0b"], timeoutMs: 1000 }),
    ).rejects.toThrow(/NUL/);
  });

  it("runs in the project directory unless told otherwise", async () => {
    const result = await runner().run({ argv: ["docker", "cwd"], timeoutMs: 5000 });
    expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(cwd));
  });

  it("filters the environment down to what Docker needs plus fixed and explicit variables", async () => {
    const result = await runner(
      {
        DOCKER_HOST: "unix:///run/docker.sock",
        MASTER_KEY: "must-not-leak",
        DATABASE_URL: "postgres://x:y@z/db",
      },
      { DOCKER_CONFIG: "/state/docker-config" },
    ).run({
      argv: ["docker", "env"],
      env: { APP_IMAGE: "ghcr.io/x/notes:1.1.0" },
      timeoutMs: 5000,
    });
    const lines = result.stdout.split("\n");
    expect(lines).toContain("DOCKER_HOST=unix:///run/docker.sock");
    expect(lines).toContain("DOCKER_CONFIG=/state/docker-config");
    expect(lines).toContain("HOME=/home/updater");
    expect(lines).toContain("APP_IMAGE=ghcr.io/x/notes:1.1.0");
    expect(lines).toContain("COMPOSE_ANSI=never");
    expect(result.stdout).not.toContain("must-not-leak");
    expect(result.stdout).not.toContain("DATABASE_URL");
  });

  it("writes stdout to a new 0600 file, hashing and counting it, optionally gzipped", async () => {
    const input = path.join(dir, "in.txt");
    await fs.writeFile(input, "from the file\n");
    const output = path.join(dir, "out.txt");
    const result = await runner().run({
      argv: ["docker", "cat"],
      stdinFile: input,
      stdoutFile: output,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    expect(await fs.readFile(output, "utf8")).toBe("from the file\n");
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
    expect(result.written).toEqual({
      bytes: 14,
      sha256: createHash("sha256").update("from the file\n").digest("hex"),
    });

    const zipped = path.join(dir, "out.gz");
    const gz = await runner().run({
      argv: ["docker", "cat"],
      stdinFile: input,
      stdoutFile: zipped,
      gzipStdout: true,
      timeoutMs: 5000,
    });
    const stored = await fs.readFile(zipped);
    expect(gunzipSync(stored).toString()).toBe("from the file\n");
    expect(gz.written?.sha256).toBe(createHash("sha256").update(stored).digest("hex"));
    // An existing file is never overwritten.
    const again = await runner().run({
      argv: ["docker", "cat"],
      stdinFile: input,
      stdoutFile: output,
      timeoutMs: 5000,
    });
    expect(again.written).toBeNull();
  });

  it("reports the redacted tail of a failing command", async () => {
    const result = await runner().run({ argv: ["docker", "fail"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(3);
    expect(result.errorTail).toContain("boom");
    expect(result.errorTail).not.toContain("abcdefghijklmnop");
  });

  it("kills a command at its timeout and on abort", async () => {
    const started = Date.now();
    const timedOut = await runner().run({ argv: ["docker", "sleep"], timeoutMs: 200 });
    expect(timedOut.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await runner().run({
      argv: ["docker", "sleep"],
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(aborted.aborted).toBe(true);
  });

  it("caps captured output", async () => {
    const result = await runner().run({
      argv: ["docker", "big"],
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
});
