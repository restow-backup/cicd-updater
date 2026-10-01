import { defaultReleaseDeps, runReleaseCli } from "./cli.js";

/** Entry point of the bundled release tools (actions/lib/release-tools.mjs). */
runReleaseCli(process.argv.slice(2), defaultReleaseDeps()).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
