import { spawn } from "node:child_process";

/**
 * Running cosign, docker and git on the CI runner: argument vectors, no shell,
 * output captured and capped.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  argv: readonly [string, ...string[]],
  options?: { env?: Readonly<Record<string, string>>; cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;

const CAP = 4 * 1024 * 1024;

export const exec: Exec = (argv, options = {}) =>
  new Promise((resolve) => {
    const [program, ...args] = argv;
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < CAP) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

/** Throw with the stderr tail when a command failed. */
export function expectOk(result: ExecResult, what: string): ExecResult {
  if (result.exitCode !== 0) {
    throw new Error(
      `${what} failed (exit code ${result.exitCode}): ${result.stderr.trim().slice(-2000)}`,
    );
  }
  return result;
}
