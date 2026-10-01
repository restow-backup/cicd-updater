import { z } from "zod";
import { type ConfigProblem, configObjectSchema } from "./config.js";

/**
 * Environment overrides for `updater.yaml` (design 4.4).
 *
 * Every scalar key and every list of strings outside `services`, `images`,
 * `hooks.*.command`, `*.argv`, `hooks.smoke.checks`,
 * `hooks.health.http.conditions` and `source.build` can be set with
 * `CICD_UPDATER_` + the key path, each segment converted from camelCase to
 * UPPER_SNAKE_CASE and joined by `__` (`compose.projectDir` ->
 * `CICD_UPDATER_COMPOSE__PROJECT_DIR`).
 *
 * The set of keys is derived from the generated JSON Schema of the
 * configuration, so it cannot drift from the schema.
 */

export const ENV_PREFIX = "CICD_UPDATER_";
/** Variables with the prefix that are not configuration keys. */
export const RESERVED_ENV = new Set(["CICD_UPDATER_CONFIG"]);

export type OverrideKind = "boolean" | "integer" | "string" | "string-list";

export interface OverrideKey {
  path: string[];
  envName: string;
  kind: OverrideKind;
  nullable: boolean;
  enum: string[] | null;
}

const EXCLUDED_PREFIXES: readonly string[][] = [
  ["version"],
  ["services"],
  ["images"],
  ["hooks", "smoke", "checks"],
  ["hooks", "health", "http", "conditions"],
  ["source", "build"],
];

function excluded(path: readonly string[]): boolean {
  if (path.includes("argv")) {
    return true;
  }
  // hooks.<name>.command
  if (path[0] === "hooks" && path[2] === "command") {
    return true;
  }
  return EXCLUDED_PREFIXES.some(
    (prefix) =>
      prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment),
  );
}

/** `projectDir` -> `PROJECT_DIR`. */
export function toUpperSnake(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function envNameOf(path: readonly string[]): string {
  return ENV_PREFIX + path.map(toUpperSnake).join("__");
}

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

function typesOf(node: JsonSchema): string[] {
  if (Array.isArray(node.type)) {
    return node.type;
  }
  return node.type ? [node.type] : [];
}

function collect(node: JsonSchema, path: string[], nullable: boolean, out: OverrideKey[]): void {
  if (path.length > 0 && excluded(path)) {
    return;
  }
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    const isNull = (member: JsonSchema): boolean =>
      typesOf(member).length === 1 && typesOf(member)[0] === "null";
    const members = union.filter((member) => !isNull(member));
    const hasNull = members.length !== union.length;
    if (members.length === 1) {
      collect(members[0] as JsonSchema, path, nullable || hasNull, out);
    }
    return;
  }
  const types = typesOf(node);
  const isNullable = nullable || types.includes("null");
  const base = types.filter((type) => type !== "null");
  if (base.length !== 1) {
    return;
  }
  const type = base[0];
  if (type === "object") {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      collect(child, [...path, key], false, out);
    }
    return;
  }
  if (path.length === 0) {
    return;
  }
  const record = (kind: OverrideKind, values: string[] | null = null): void => {
    out.push({ path, envName: envNameOf(path), kind, nullable: isNullable, enum: values });
  };
  if (type === "boolean") {
    record("boolean");
  } else if (type === "integer") {
    record("integer");
  } else if (type === "string") {
    record("string", Array.isArray(node.enum) ? node.enum.map(String) : null);
  } else if (type === "array") {
    const items = node.items;
    if (items && typesOf(items).length === 1 && typesOf(items)[0] === "string") {
      record("string-list");
    }
  }
}

let cached: OverrideKey[] | null = null;

/** Every key that can be set from the environment, in schema order. */
export function overridableKeys(): OverrideKey[] {
  if (!cached) {
    const schema = z.toJSONSchema(configObjectSchema, {
      io: "input",
      unrepresentable: "any",
    }) as JsonSchema;
    const out: OverrideKey[] = [];
    collect(schema, [], false, out);
    cached = out;
  }
  return cached;
}

function setPath(document: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current: Record<string, unknown> = document;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[path[path.length - 1] as string] = value;
}

export interface OverrideResult {
  document: Record<string, unknown>;
  /** Environment variable names that were applied. */
  applied: string[];
  problems: ConfigProblem[];
}

/**
 * Apply `CICD_UPDATER_*` variables to a parsed document (a copy is returned).
 * An override for an unknown key, or a value that does not convert, is a problem.
 */
export function applyEnvOverrides(
  document: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): OverrideResult {
  const result = structuredClone(document) as Record<string, unknown>;
  const keys = new Map(overridableKeys().map((key) => [key.envName, key]));
  const applied: string[] = [];
  const problems: ConfigProblem[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith(ENV_PREFIX) || RESERVED_ENV.has(name)) {
      continue;
    }
    const raw = env[name];
    if (raw === undefined) {
      continue;
    }
    const key = keys.get(name);
    if (!key) {
      problems.push({
        path: name,
        message: "is not a configuration key that can be set from the environment",
      });
      continue;
    }
    const value = raw.trim();
    const where = `${name} (${key.path.join(".")})`;
    let converted: unknown;
    if (key.kind === "string-list") {
      converted =
        value === ""
          ? []
          : value
              .split(",")
              .map((item) => item.trim())
              .filter((item) => item !== "");
    } else if (value === "") {
      if (!key.nullable) {
        problems.push({ path: where, message: "must not be empty" });
        continue;
      }
      converted = null;
    } else if (key.kind === "boolean") {
      if (value !== "true" && value !== "false") {
        problems.push({ path: where, message: "must be true or false" });
        continue;
      }
      converted = value === "true";
    } else if (key.kind === "integer") {
      if (!/^-?\d{1,15}$/.test(value)) {
        problems.push({ path: where, message: "must be a decimal integer" });
        continue;
      }
      converted = Number(value);
    } else {
      converted = value;
    }
    setPath(result, key.path, converted);
    applied.push(name);
  }
  return { document: result, applied, problems };
}
