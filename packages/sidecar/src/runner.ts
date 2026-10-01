import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  createWriteStream,
  constants as fsConstants,
  openSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Redactor } from "@cicd-updater/engine";

/**
 * Runs the sidecar's external programs (`docker`, `cosign`, `age`, `tar`).
 * Commands are argument vectors handed straight to the operating system (no
 * shell), the environment is filtered down to what the program needs, output
 * is capped, every tail that leaves this file is redacted, and secrets never
 * appear in argv or in a child's environment (design 8.7).
 *
 * Derived from Restow's updater (Apache-2.0).
 */

export const PROGRAMS = ["docker", "cosign", "age", "tar"] as const;
export type Program = (typeof PROGRAMS)[number];

export interface CommandSpec {
  /** Program and arguments. Never a shell string. */
  argv: readonly [Program, ...string[]];
  /** Extra environment variables for this command (nothing secret). */
  env?: Readonly<Record<string, string>>;
  /** Write stdout to this new file (mode 0600) instead of capturing it; hashed and counted while writing. */
  stdoutFile?: string;
  /** gzip stdout before it is written to `stdoutFile`. */
  gzipStdout?: boolean;
  /** Feed this file to stdin. */
  stdinFile?: string;
  timeoutMs: number;
  /** Cap for captured stdout in bytes (default 4 MiB). */
  maxOutputBytes?: number;
  /** Kill the command when this aborts. */
  signal?: AbortSignal;
  /** Working directory (default: the runner's). */
  cwd?: string;
}

export interface CommandResult {
  exitCode: number;
  /** Captured stdout (may hold configuration; never log it). Empty with `stdoutFile`. */
  stdout: string;
  /** Redacted tail of stderr (or of stdout when stderr is empty). */
  errorTail: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** With `stdoutFile`: bytes written and their SHA-256. */
  written: { bytes: number; sha256: string } | null;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
  /** Whether a program exists on PATH. */
  available(program: Program): boolean;
}

/** Variables passed through from the sidecar's own environment; everything else is dropped. */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TZ",
] as const;

const FIXED_ENV: Readonly<Record<string, string>> = {
  NO_COLOR: "1",
  COMPOSE_ANSI: "never",
  COMPOSE_PROGRESS: "plain",
  BUILDKIT_PROGRESS: "plain",
};

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const TAIL_BYTES = 16 * 1024;
const KILL_GRACE_MS = 5000;
const EXIT_GRACE_MS = 1000;

export function findExecutable(name: string, pathEnv: string | undefined): string | null {
  if (name.includes("/")) {
    return isExecutable(name) ? name : null;
  }
  for (const directory of (pathEnv ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size - (this.chunks[0]?.length ?? 0) >= TAIL_BYTES) {
      const dropped = this.chunks.shift();
      this.size -= dropped?.length ?? 0;
    }
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    return all.subarray(Math.max(0, all.length - TAIL_BYTES)).toString("utf8");
  }
}

export interface LocalRunnerOptions {
  redactor: Redactor;
  /** Working directory of every command: the project directory, where Compose finds its files. */
  cwd: string;
  /** The environment to filter (default: this process's). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Extra fixed variables for every command (DOCKER_CONFIG of the registry credentials). */
  fixedEnv?: Readonly<Record<string, string>>;
}

export class LocalRunner implements CommandRunner {
  private readonly binaries = new Map<Program, string | null>();
  private readonly baseEnv: Record<string, string>;

  constructor(private readonly options: LocalRunnerOptions) {
    const source = options.env ?? process.env;
    for (const program of PROGRAMS) {
      this.binaries.set(program, findExecutable(program, source.PATH));
    }
    const base: Record<string, string> = {};
    for (const name of PASSTHROUGH_ENV) {
      const value = source[name];
      if (value !== undefined) {
        base[name] = value;
      }
    }
    base.HOME ??= "/root";
    this.baseEnv = { ...base, ...FIXED_ENV, ...(options.fixedEnv ?? {}) };
  }

  available(program: Program): boolean {
    return this.binaries.get(program) !== null;
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    const { redactor } = this.options;
    const [program, ...args] = spec.argv;
    if (!PROGRAMS.includes(program)) {
      throw new Error(`The program ${String(program)} cannot be run.`);
    }
    const binary = this.binaries.get(program);
    if (!binary) {
      return {
        exitCode: 127,
        stdout: "",
        errorTail: `The ${program} executable was not found in PATH.`,
        timedOut: false,
        aborted: false,
        truncated: false,
        written: null,
      };
    }
    for (const file of [spec.stdoutFile, spec.stdinFile]) {
      if (file !== undefined && (!path.isAbsolute(file) || file.includes("\0"))) {
        throw new Error("Command files must be absolute paths.");
      }
    }
    for (const arg of args) {
      if (arg.includes("\0")) {
        throw new Error("An argument contains NUL.");
      }
    }

    let inFd: number | null = null;
    try {
      inFd = spec.stdinFile ? openSync(spec.stdinFile, "r") : null;
    } catch (error) {
      return {
        exitCode: 126,
        stdout: "",
        errorTail: redactor.tail(`Could not open the input file: ${(error as Error).message}`),
        timedOut: false,
        aborted: false,
        truncated: false,
        written: null,
      };
    }

    const maxOutput = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const child = spawn(binary, args, {
      cwd: spec.cwd ?? this.options.cwd,
      env: { ...this.baseEnv, ...(spec.env ?? {}) },
      stdio: [inFd ?? "ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;
    const stdoutTail = new TailBuffer();
    const stderrTail = new TailBuffer();
    let timedOut = false;
    let aborted = false;
    let written: { bytes: number; sha256: string } | null = null;

    // stdout to a file: optional gzip, then hash and count what is stored.
    let fileWrite: Promise<void> | null = null;
    if (spec.stdoutFile && child.stdout) {
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      });
      const sink = createWriteStream(spec.stdoutFile, { flags: "wx", mode: 0o600 });
      const tap = new PassThrough();
      tap.on("data", (chunk: Buffer) => stdoutTail.push(chunk));
      fileWrite = (
        spec.gzipStdout
          ? pipeline(child.stdout, tap, createGzip(), meter, sink)
          : pipeline(child.stdout, tap, meter, sink)
      ).then(() => {
        written = { bytes, sha256: hash.digest("hex") };
      });
      fileWrite.catch(() => undefined);
    } else {
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutTail.push(chunk);
        const room = maxOutput - stdoutBytes;
        if (room <= 0) {
          truncated = true;
          return;
        }
        if (chunk.length > room) {
          truncated = true;
          stdoutChunks.push(chunk.subarray(0, room));
          stdoutBytes += room;
        } else {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
    }
    child.stderr?.on("data", (chunk: Buffer) => stderrTail.push(chunk));

    const kill = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) {
      onAbort();
    }

    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      const finish = (code: number): void => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };
      child.on("error", (error) => {
        stderrTail.push(Buffer.from(error.message));
        finish(127);
      });
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
      // A grandchild can keep the pipes open after the command ended: do not wait for ever.
      child.on("exit", (code, signal) => {
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code ?? (signal ? 128 : 1));
        }, EXIT_GRACE_MS).unref();
      });
    });
    clearTimeout(killTimer);
    spec.signal?.removeEventListener("abort", onAbort);
    if (inFd !== null) {
      closeSync(inFd);
    }
    if (fileWrite) {
      try {
        await fileWrite;
      } catch (error) {
        stderrTail.push(Buffer.from(`\nwriting the output failed: ${(error as Error).message}`));
        written = null;
      }
    }
    const stderrText = stderrTail.toString();
    const tailSource = stderrText.trim() ? stderrText : stdoutTail.toString();
    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      errorTail: redactor.tail(tailSource),
      timedOut,
      aborted,
      truncated,
      written,
    };
  }
}

/** Remove a file, ignoring that it does not exist. */
export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
