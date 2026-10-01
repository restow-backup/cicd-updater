/**
 * The restricted JSONPath of `versionJsonPath`, `conditions[].path` and
 * `migrationProbe.http.jsonPath` (design 4.5): `$` followed by 1 to 10 segments,
 * each `.name` (name `^[A-Za-z_][A-Za-z0-9_-]*$`) or `[index]` (non-negative
 * integer). No wildcards, filters or recursion. A missing path is "no value".
 */

export type PathSegment = { kind: "name"; name: string } | { kind: "index"; index: number };

const SEGMENT = /\.([A-Za-z_][A-Za-z0-9_-]*)|\[(0|[1-9][0-9]{0,8})\]/y;
export const MAX_PATH_SEGMENTS = 10;

/** Parse a path; null when it does not follow the grammar. */
export function parseJsonPath(path: string): PathSegment[] | null {
  if (typeof path !== "string" || !path.startsWith("$") || path.length > 512) {
    return null;
  }
  const segments: PathSegment[] = [];
  let position = 1;
  while (position < path.length) {
    SEGMENT.lastIndex = position;
    const match = SEGMENT.exec(path);
    if (!match) {
      return null;
    }
    if (match[1] !== undefined) {
      segments.push({ kind: "name", name: match[1] });
    } else {
      segments.push({ kind: "index", index: Number(match[2]) });
    }
    position = SEGMENT.lastIndex;
  }
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) {
    return null;
  }
  return segments;
}

export function isValidJsonPath(path: string): boolean {
  return parseJsonPath(path) !== null;
}

/** The value at `path`, or `undefined` when the path does not exist (or is invalid). */
export function valueAtPath(document: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  if (!segments) {
    return undefined;
  }
  let current: unknown = document;
  for (const segment of segments) {
    if (segment.kind === "name") {
      if (
        current === null ||
        typeof current !== "object" ||
        Array.isArray(current) ||
        !Object.hasOwn(current, segment.name)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment.name];
    } else {
      if (!Array.isArray(current) || segment.index >= current.length) {
        return undefined;
      }
      current = current[segment.index];
    }
  }
  return current;
}

/** A scalar value as text (for versions and probe values); null for objects, arrays and missing values. */
export function scalarText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return null;
}
