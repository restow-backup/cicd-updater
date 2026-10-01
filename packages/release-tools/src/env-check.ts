/**
 * `release env-check` (design 10.6 smoke step 1): every `${VAR}` a Compose file
 * references must appear in `.env.example`, so production never meets a
 * variable nobody documented. Commented lines (`# VAR=`) count: optional
 * variables are documented commented out.
 */

const REFERENCE =
  /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::?[-?+])[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Variables a Compose file text references (`$$` is an escaped dollar). */
export function composeVariables(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) {
      continue;
    }
    for (const match of line.matchAll(REFERENCE)) {
      const name = match[1] ?? match[2];
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

/** Keys `.env.example` documents, assigned or commented out. */
export function documentedVariables(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

export interface EnvCheckResult {
  ok: boolean;
  /** Referenced by a Compose file, missing in the example. */
  missing: string[];
  referenced: string[];
}

export function envCheck(
  composeTexts: readonly string[],
  example: string,
  ignore: readonly string[] = [],
): EnvCheckResult {
  const referenced = new Set<string>();
  for (const text of composeTexts) {
    for (const name of composeVariables(text)) {
      referenced.add(name);
    }
  }
  const documented = documentedVariables(example);
  const missing = [...referenced]
    .filter((name) => !documented.has(name) && !ignore.includes(name))
    .sort();
  return { ok: missing.length === 0, missing, referenced: [...referenced].sort() };
}

/**
 * The env file the smoke test starts with: `.env.example` as written (empty
 * optional values stay empty, because that is what production gets), commented
 * lines left out, plus the image variables and overrides appended.
 */
export function smokeEnvFile(
  example: string,
  assignments: Readonly<Record<string, string>>,
): string {
  const lines: string[] = [];
  for (const line of example.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1] && !Object.hasOwn(assignments, match[1])) {
      lines.push(line);
    }
  }
  for (const [key, value] of Object.entries(assignments)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Invalid smoke variable ${key}.`);
    }
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}
