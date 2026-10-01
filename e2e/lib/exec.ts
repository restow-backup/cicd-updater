import { spawn } from "node:child_process";

/** A finished process. */
export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to stdin (and stdin closed). */
  input?: string | Buffer;
  /** Kill after this many milliseconds (default 10 minutes). */
  timeoutMs?: number;
  /** Do not throw on a non-zero exit code. */
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class CommandError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: Result,
  ) {
    const tail = (text: string) => text.trim().split("\n").slice(-25).join("\n");
    super(
      `${argv.slice(0, 6).join(" ")}${argv.length > 6 ? " …" : ""} exited ${result.code}\n` +
        `--- stdout\n${tail(result.stdout)}\n--- stderr\n${tail(result.stderr)}`,
    );
  }
}

/** Run a program on the machine that runs the tests (argv, no shell). */
export function run(argv: readonly string[], options: RunOptions = {}): Promise<Result> {
  const [program, ...args] = argv;
  if (!program) {
    throw new Error("empty argv");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 600_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code !== 0 && !options.allowFail) {
        reject(new CommandError(argv, result));
      } else {
        resolve(result);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

/** Quote one word for sh. */
export function q(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `check` returns a value (not undefined), or fail after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  { timeoutMs = 120_000, intervalMs = 1000 } = {},
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    }
    await sleep(intervalMs);
  }
}
