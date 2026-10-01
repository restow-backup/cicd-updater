/**
 * Checks for the composite actions, workflows and workflow templates (design 10.7
 * `lint`): every third-party action is pinned by a full commit SHA with a version
 * comment, composite actions use only declared inputs and known step ids, no
 * `${{ }}` expression is expanded inside a shell script (values go through env),
 * and every run script passes `bash -n` and, when installed, shellcheck.
 * actionlint covers the workflows themselves in CI.
 *
 *   pnpm lint:actions
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
}

function files(dir: string, pattern: RegExp): string[] {
  let result: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry === "node_modules") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result = result.concat(files(full, pattern));
    } else if (pattern.test(full)) {
      result.push(full);
    }
  }
  return result;
}

const targets = [
  ...files(join(root, "actions"), /action\.ya?ml$/),
  ...files(join(root, ".github", "workflows"), /\.ya?ml$/),
  ...files(join(root, "templates"), /\.ya?ml$/),
  ...files(join(root, "examples"), /\.(github|forgejo|gitea)\/workflows\/[^/]+\.ya?ml$/),
];

const work = mkdtempSync(join(tmpdir(), "cicd-updater-lint-"));
let shellcheck = true;
try {
  execFileSync("shellcheck", ["--version"], { stdio: "pipe" });
} catch {
  shellcheck = false;
}
const problems: string[] = [];

for (const file of targets) {
  const name = relative(root, file);
  const text = readFileSync(file, "utf8");
  const doc = parse(text) as {
    inputs?: Record<string, unknown>;
    runs?: { using?: string; steps?: Step[] };
    jobs?: Record<string, { steps?: Step[] }>;
  } | null;
  if (!doc || typeof doc !== "object") {
    continue;
  }
  const composite = doc.runs?.using === "composite";
  const steps: Step[] = composite
    ? (doc.runs?.steps ?? [])
    : Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []);

  text.split("\n").forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(line);
    if (!match?.[1] || match[1].startsWith("./") || match[1].startsWith("docker://")) {
      return;
    }
    // Templates and examples reference this project's actions by release tag: the
    // commit SHA of a release does not exist before it is tagged. Adopters pin the SHA.
    if (
      /^(https:\/\/github\.com\/)?restow-backup\/cicd-updater\/actions\/[a-z-]+@v\d+\.\d+\.\d+$/.test(
        match[1],
      ) &&
      !name.startsWith("actions/")
    ) {
      return;
    }
    const action = match[1].replace(/^https:\/\/github\.com\//, "");
    if (!/@[0-9a-f]{40}$/.test(action)) {
      problems.push(`${name}:${index + 1}: ${action} is not pinned by a full commit SHA`);
    } else if (!/^#\s*v\d+(\.\d+)*/.test(match[2] ?? "")) {
      problems.push(`${name}:${index + 1}: ${action} has no version comment (# vX.Y.Z)`);
    }
  });

  if (composite) {
    const declared = new Set(Object.keys(doc.inputs ?? {}));
    for (const match of text.matchAll(/\binputs\.([A-Za-z0-9_-]+)/g)) {
      if (match[1] && !declared.has(match[1])) {
        problems.push(`${name}: undeclared input ${match[1]}`);
      }
    }
    for (const step of steps) {
      if (step.run && !step.shell) {
        problems.push(`${name}: step "${step.name}" has no shell (composite steps need one)`);
      }
    }
  }
  const ids = new Set(steps.map((step) => step.id).filter(Boolean));
  for (const match of text.matchAll(/\bsteps\.([A-Za-z0-9_-]+)\.outputs/g)) {
    if (match[1] && !ids.has(match[1])) {
      problems.push(`${name}: unknown step id ${match[1]}`);
    }
  }

  steps.forEach((step, index) => {
    if (!step.run) {
      return;
    }
    if (/\$\{\{/.test(step.run)) {
      problems.push(
        `${name}: step "${step.name}" expands an expression inside the script; pass it via env`,
      );
    }
    if (step.shell && !/^(bash|sh)\b/.test(step.shell)) {
      return;
    }
    const script = join(work, `${index}.sh`);
    writeFileSync(
      script,
      `#!/usr/bin/env bash\n${step.run.replace(/\$\{\{[^}]*\}\}/g, "placeholder")}\n`,
    );
    try {
      execFileSync("bash", ["-n", script], { stdio: "pipe" });
    } catch (error) {
      problems.push(`${name}: step "${step.name}": ${(error as { stderr?: Buffer }).stderr}`);
      return;
    }
    if (shellcheck) {
      try {
        // SC2016: single-quoted node -e programs are intended.
        execFileSync("shellcheck", ["-s", "bash", "-e", "SC2016", script], { stdio: "pipe" });
      } catch (error) {
        problems.push(
          `${name}: step "${step.name}":\n${(error as { stdout?: Buffer }).stdout?.toString()}`,
        );
      }
    }
  });
}

rmSync(work, { recursive: true, force: true });
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(problem);
  }
  process.exitCode = 1;
} else {
  console.log(
    `${targets.length} files checked${shellcheck ? "" : " (shellcheck not installed: syntax only)"}.`,
  );
}
