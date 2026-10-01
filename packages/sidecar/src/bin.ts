import { defaultReleaseDeps, runReleaseCli } from "@cicd-updater/release-tools";
import { runCli } from "./cli.js";
import { consoleIo } from "./main.js";

/** The `cicd-updater` executable of the sidecar image. */
async function main(): Promise<number> {
  const { createInterface } = await import("node:readline/promises");
  return await runCli(process.argv.slice(2), {
    env: process.env,
    io: consoleIo,
    fetch,
    stdout: process.stdout,
    confirm: process.stdin.isTTY
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : null,
    release: (args, io) => runReleaseCli(args, { ...defaultReleaseDeps(), io }),
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`cicd-updater: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  },
);
