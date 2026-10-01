import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  applyEnvOverrides,
  CONFIG_MAX_BYTES,
  type ConfigProblem,
  canonicalJson,
  DEFAULT_CONFIG_PATH,
  type UpdaterConfig,
  validateConfig,
} from "@cicd-updater/protocol";
import { isAlias, LineCounter, parseAllDocuments, visit } from "yaml";

/**
 * Loading `updater.yaml` (design 4.1): one YAML 1.2 document of at most 256
 * KiB, UTF-8, no anchors or aliases, unknown keys refused; environment
 * overrides applied; every problem collected (one line each, path and reason).
 * The configuration hash is the SHA-256 of the canonical JSON of the effective
 * configuration.
 */

export type LoadedConfig =
  | { ok: true; file: string; config: UpdaterConfig; configHash: string; overrides: string[] }
  | { ok: false; file: string; problems: ConfigProblem[] };

export function configHashOf(config: UpdaterConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** Parse the text of updater.yaml into a plain object (or problems). */
export function parseConfigText(text: string): {
  document: Record<string, unknown> | null;
  problems: ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  if (Buffer.byteLength(text, "utf8") > CONFIG_MAX_BYTES) {
    return {
      document: null,
      problems: [{ path: "(file)", message: `is larger than ${CONFIG_MAX_BYTES} bytes` }],
    };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    version: "1.2",
    uniqueKeys: true,
    lineCounter,
    prettyErrors: false,
  });
  const list = Array.isArray(documents) ? documents : [];
  if (list.length !== 1) {
    return {
      document: null,
      problems: [
        {
          path: "(file)",
          message: list.length === 0 ? "is empty" : "must contain exactly one YAML document",
        },
      ],
    };
  }
  const document = list[0];
  if (!document) {
    return { document: null, problems: [{ path: "(file)", message: "is empty" }] };
  }
  for (const error of document.errors) {
    const position = error.pos ? lineCounter.linePos(error.pos[0]) : null;
    problems.push({
      path: position ? `(line ${position.line}, column ${position.col})` : "(file)",
      message: error.message.split("\n")[0] ?? "YAML error",
    });
  }
  if (problems.length > 0) {
    return { document: null, problems };
  }
  let anchors = false;
  visit(document, {
    Node(_key, node) {
      if (isAlias(node) || (node as { anchor?: string }).anchor) {
        anchors = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (anchors) {
    return {
      document: null,
      problems: [{ path: "(file)", message: "anchors and aliases are not allowed" }],
    };
  }
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { document: null, problems: [{ path: "(root)", message: "must be a mapping" }] };
  }
  return { document: value as Record<string, unknown>, problems: [] };
}

/** Load, override from the environment, validate. */
export async function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  file: string = env.CICD_UPDATER_CONFIG?.trim() || DEFAULT_CONFIG_PATH,
): Promise<LoadedConfig> {
  let text: string;
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      if (stat.size > CONFIG_MAX_BYTES) {
        return {
          ok: false,
          file,
          problems: [{ path: "(file)", message: `is larger than ${CONFIG_MAX_BYTES} bytes` }],
        };
      }
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      ok: false,
      file,
      problems: [
        {
          path: "(file)",
          message: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
        },
      ],
    };
  }
  const parsed = parseConfigText(text);
  if (!parsed.document) {
    return { ok: false, file, problems: parsed.problems };
  }
  const overridden = applyEnvOverrides(parsed.document, env);
  const validated = validateConfig(overridden.document);
  const problems = [...overridden.problems, ...(validated.ok ? [] : validated.problems)];
  if (problems.length > 0 || !validated.ok) {
    return { ok: false, file, problems };
  }
  return {
    ok: true,
    file,
    config: validated.config,
    configHash: configHashOf(validated.config),
    overrides: overridden.applied,
  };
}

/** The effective configuration for display: string values pass the redactor (nothing in it should be secret). */
export function configView(
  config: UpdaterConfig,
  redact: (text: string) => string,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return redact(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return walk(config) as Record<string, unknown>;
}

export function formatProblems(file: string, problems: readonly ConfigProblem[]): string {
  return [
    `cicd-updater: invalid configuration in ${file}:`,
    ...problems.map((problem) => `  ${problem.path}: ${problem.message}`),
  ].join("\n");
}
