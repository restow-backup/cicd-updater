/**
 * Redaction for everything that leaves the sidecar or is stored: log lines,
 * failure details, status.json, problem details. The sidecar holds the Docker
 * socket and, briefly, tokens for private repositories; neither the shared
 * token nor any other secret may appear in text an operator or the app reads.
 *
 * Two layers:
 *
 *   1. Known secrets. Values the process holds (the shared token, feed and
 *      source tokens, credential-looking values of the env file) are
 *      registered and removed by exact match, wherever they occur.
 *   2. Patterns. Shapes that carry credentials (`Authorization:` headers,
 *      `Bearer` values, `scheme://user:pass@host`, well-known token prefixes,
 *      `password=...` pairs) plus the operator's `logging.redactPatterns`.
 *
 * Derived from Restow's updater (Apache-2.0).
 */

export const REDACTED = "[redacted]";

/** Values shorter than this are not registered (replacing "ab" everywhere would destroy the text). */
const MIN_SECRET_LENGTH = 6;
/** Registered secrets never number more than this; the oldest is dropped first. */
const MAX_REGISTERED = 256;

interface Rule {
  pattern: RegExp;
  replace: string | ((substring: string, ...groups: string[]) => string);
}

const RULES: readonly Rule[] = [
  // `Authorization: Bearer abc`, `Authorization: token abc`, `authorization=Basic abc`
  {
    pattern: /(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|token|basic)\s+)?[^\s"',;]+/gi,
    replace: (_all, prefix) => `${prefix}${REDACTED}`,
  },
  // `PRIVATE-TOKEN: abc` (GitLab)
  {
    pattern: /(private-token["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    replace: (_all, prefix) => `${prefix}${REDACTED}`,
  },
  // `Bearer abc.def`
  { pattern: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replace: `$1 ${REDACTED}` },
  // `token ghp_abc` (a value that looks like a token: long, not a plain word)
  {
    pattern: /\b(token)\s+(?=[A-Za-z0-9._~+/=-]*[0-9_])[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `$1 ${REDACTED}`,
  },
  // `scheme://user:pass@host` and `scheme://token@host`
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, replace: `$1${REDACTED}@` },
  // key=value pairs whose key names a credential (quotes around the value are kept)
  {
    pattern:
      /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|apikey|api_key|[_-]key))(["']?\s*[=:]\s*)(?:(")[^"]*"|(')[^']*'|[^\s"',;]+)/gi,
    replace: (_all, key, separator, doubleQuote, singleQuote) => {
      const quote = doubleQuote || singleQuote || "";
      return `${key}${separator}${quote}${REDACTED}${quote}`;
    },
  },
  // Well-known token prefixes (GitHub, GitLab, npm).
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, replace: REDACTED },
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: REDACTED },
  // age secret keys (never on the host, but never printed either).
  { pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/g, replace: REDACTED },
];

export class Redactor {
  private readonly secrets: string[] = [];
  private readonly extra: RegExp[];

  /** `patterns`: extra regular expressions whose matches are replaced (logging.redactPatterns). */
  constructor(patterns: readonly string[] = []) {
    this.extra = patterns.map((pattern) => new RegExp(pattern, "g"));
  }

  /** Register a value that must never be printed. Returns false when it is too short to register. */
  add(value: string | null | undefined): boolean {
    if (!value || value.length < MIN_SECRET_LENGTH) {
      return false;
    }
    if (!this.secrets.includes(value)) {
      this.secrets.push(value);
      if (this.secrets.length > MAX_REGISTERED) {
        this.secrets.shift();
      }
    }
    return true;
  }

  /** Stop redacting a value (the token of a finished run). */
  forget(value: string | null | undefined): void {
    if (!value) {
      return;
    }
    const index = this.secrets.indexOf(value);
    if (index !== -1) {
      this.secrets.splice(index, 1);
    }
  }

  get size(): number {
    return this.secrets.length;
  }

  /** The text with known secrets and credential-shaped values removed. */
  redact(text: string): string {
    let out = text;
    // Longest first: a secret that contains another must not be left half visible.
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    for (const secret of ordered) {
      out = out.split(secret).join(REDACTED);
    }
    for (const rule of RULES) {
      out = out.replace(rule.pattern, rule.replace as never);
    }
    for (const pattern of this.extra) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }

  /** Redacted and collapsed to one line of at most `max` characters. */
  oneLine(text: string, max = 2000): string {
    return clip(this.redact(text).replace(/\s+/g, " ").trim(), max);
  }

  /** Redacted tail: the last `maxChars` characters. */
  tail(text: string, maxChars = 2000): string {
    const redacted = this.redact(text).replace(/\r/g, "").trim();
    return redacted.length <= maxChars ? redacted : `...${redacted.slice(-maxChars)}`;
  }
}

/** Cut to `max` characters (an ellipsis counts), never in the middle of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}

export const DEFAULT_REDACT_KEY_PATTERN =
  "(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|DSN)";

/**
 * Values in an env file whose key matches `keyPattern` (case-insensitive). Only
 * used to register them for redaction: the sidecar never passes them on, never
 * logs them and never stores them.
 */
export function sensitiveEnvValues(
  envText: string,
  keyPattern = DEFAULT_REDACT_KEY_PATTERN,
): string[] {
  const keyRegex = new RegExp(keyPattern, "i");
  const values: string[] = [];
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    if (!keyRegex.test(key)) {
      continue;
    }
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (value.length >= MIN_SECRET_LENGTH) {
      values.push(value);
    }
  }
  return values;
}
