import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * The Compose env file, edited byte-exactly (design 5.3 start). The sidecar
 * changes only its writable keys (every `services[].imageVar` plus
 * `env.versionVar`) and leaves everything else as the operator wrote it:
 * comments, blank lines, order, quoting, line endings, `export` prefixes, a
 * missing final newline, earlier duplicate assignments. A rollback puts the
 * keys back byte for byte, including "the key was not there".
 *
 * The file is a list of lines that each remember their terminator (`\n`,
 * `\r\n` or none for a last line without one), so rendering the parsed lines
 * reproduces the input exactly.
 *
 * Derived from Restow's updater (Apache-2.0).
 */

export type LineEnding = "" | "\n" | "\r\n";

export interface EnvLine {
  text: string;
  eol: LineEnding;
}

/** What one key looked like before the update. */
export interface CapturedKey {
  present: boolean;
  /** The last assignment line as written (without its line ending); null when absent. */
  line: string | null;
  /** The parsed value (quotes removed); null when absent. */
  value: string | null;
}

export type CapturedEnv = Record<string, CapturedKey>;

export class EnvFileError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "unwritable" | "invalid_value" | "invalid_setting",
  ) {
    super(message);
    this.name = "EnvFileError";
  }
}

export function parseEnvLines(text: string): EnvLine[] {
  const lines: EnvLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ text: text.slice(start), eol: "" });
      break;
    }
    const crlf = newline > start && text[newline - 1] === "\r";
    lines.push({
      text: text.slice(start, crlf ? newline - 1 : newline),
      eol: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

export function renderEnvLines(lines: readonly EnvLine[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

function dominantEol(lines: readonly EnvLine[]): "\n" | "\r\n" {
  return lines.some((line) => line.eol === "\r\n") ? "\r\n" : "\n";
}

/** The key a line assigns (`KEY=...`, `export KEY=...`), or null for comments and other lines. */
export function assignedKey(lineText: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(lineText);
  return match?.[1] ?? null;
}

/** The value part of an assignment line with quotes and inline comment removed. */
export function assignedValue(lineText: string): string {
  const equals = lineText.indexOf("=");
  const raw = lineText.slice(equals + 1).trimStart();
  const quote = raw[0];
  if (quote === '"') {
    let value = "";
    for (let index = 1; index < raw.length; index++) {
      const char = raw[index] as string;
      if (char === "\\" && index + 1 < raw.length) {
        const next = raw[index + 1] as string;
        if (next === '"' || next === "\\") {
          value += next;
          index += 1;
          continue;
        }
      }
      if (char === '"') {
        return value;
      }
      value += char;
    }
    return value;
  }
  if (quote === "'") {
    const end = raw.indexOf("'", 1);
    return end === -1 ? raw.slice(1) : raw.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, "").trim();
}

function lastAssignmentIndex(lines: readonly EnvLine[], key: string): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (assignedKey((lines[index] as EnvLine).text) === key) {
      return index;
    }
  }
  return -1;
}

/** The parsed value of a key (the last assignment wins, as in Compose); null when absent. */
export function envValueOf(text: string, key: string): string | null {
  const lines = parseEnvLines(text);
  const index = lastAssignmentIndex(lines, key);
  return index === -1 ? null : assignedValue((lines[index] as EnvLine).text);
}

export function captureKeys(text: string, keys: readonly string[]): CapturedEnv {
  const lines = parseEnvLines(text);
  const captured: CapturedEnv = {};
  for (const key of keys) {
    const index = lastAssignmentIndex(lines, key);
    if (index === -1) {
      captured[key] = { present: false, line: null, value: null };
    } else {
      const line = (lines[index] as EnvLine).text;
      captured[key] = { present: true, line, value: assignedValue(line) };
    }
  }
  return captured;
}

/** A value the sidecar may write: an image reference or a version, nothing Compose or a shell would interpret. */
export function assertSafeEnvValue(key: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,299}$/.test(value)) {
    throw new EnvFileError(`The value for ${key} is not a plain image reference.`, "invalid_value");
  }
}

function assertKeyName(key: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
    throw new EnvFileError(`Unsupported variable name ${key}.`, "invalid_setting");
  }
}

function removeLine(lines: EnvLine[], index: number): void {
  const [removed] = lines.splice(index, 1);
  // A last line without a terminator: the line before it gives up its terminator
  // too, so the file ends the way it did before that line was added.
  if (removed && removed.eol === "" && index > 0) {
    (lines[index - 1] as EnvLine).eol = "";
  }
}

function appendLine(lines: EnvLine[], text: string): void {
  const eol = dominantEol(lines);
  const last = lines[lines.length - 1];
  if (!last) {
    lines.push({ text, eol });
    return;
  }
  if (last.eol === "") {
    // The file had no final newline: keep it that way.
    last.eol = eol;
    lines.push({ text, eol: "" });
    return;
  }
  lines.push({ text, eol: last.eol });
}

/**
 * Set keys. An existing assignment (the last one, when there are several) is
 * replaced in place; a missing one is appended. Everything else stays untouched.
 */
export function setKeys(text: string, assignments: Readonly<Record<string, string>>): string {
  const lines = parseEnvLines(text);
  for (const [key, value] of Object.entries(assignments)) {
    assertKeyName(key);
    assertSafeEnvValue(key, value);
    const index = lastAssignmentIndex(lines, key);
    const previous = index === -1 ? null : (lines[index] as EnvLine).text;
    const prefix = previous && /^\s*export\s+/.test(previous) ? "export " : "";
    const assignment = `${prefix}${key}=${value}`;
    if (index === -1) {
      appendLine(lines, assignment);
    } else {
      (lines[index] as EnvLine).text = assignment;
    }
  }
  return renderEnvLines(lines);
}

/**
 * Put captured keys back exactly as they were: the original line where the key
 * existed, no line at all where it did not.
 */
export function restoreKeys(
  text: string,
  captured: Readonly<Record<string, Pick<CapturedKey, "present" | "line">>>,
): string {
  const lines = parseEnvLines(text);
  for (const [key, before] of Object.entries(captured)) {
    assertKeyName(key);
    if (before.present && before.line !== null) {
      const index = lastAssignmentIndex(lines, key);
      if (index === -1) {
        appendLine(lines, before.line);
      } else {
        (lines[index] as EnvLine).text = before.line;
      }
    } else {
      for (let index = lines.length - 1; index >= 0; index--) {
        if (assignedKey((lines[index] as EnvLine).text) === key) {
          removeLine(lines, index);
        }
      }
    }
  }
  return renderEnvLines(lines);
}

/** Whether two captures name the same lines (present and line text). */
export function sameCapture(
  a: Readonly<Record<string, Pick<CapturedKey, "present" | "line">>>,
  b: Readonly<Record<string, Pick<CapturedKey, "present" | "line">>>,
): string[] {
  const changed: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (!left || !right || left.present !== right.present || left.line !== right.line) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * File access for the env file. Only the writable keys passed to the
 * constructor can ever be written or restored: the refusal is in code, not
 * only in configuration.
 */
export class EnvFile {
  private readonly writable: ReadonlySet<string>;

  constructor(
    readonly filePath: string,
    writableKeys: readonly string[],
  ) {
    this.writable = new Set(writableKeys);
  }

  get writableKeys(): string[] {
    return [...this.writable];
  }

  private assertWritableKeys(keys: readonly string[]): void {
    const foreign = keys.filter((key) => !this.writable.has(key));
    if (foreign.length > 0) {
      throw new EnvFileError(
        `The sidecar writes only ${[...this.writable].join(", ")} in the env file, not ${foreign.join(", ")}.`,
        "invalid_setting",
      );
    }
  }

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new EnvFileError(`The env file ${this.filePath} does not exist.`, "missing");
      }
      throw error;
    }
  }

  /** The env file exists and can be replaced: the file and its directory are writable. */
  async assertWritable(): Promise<void> {
    try {
      await fs.access(this.filePath, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new EnvFileError(`The env file ${this.filePath} does not exist.`, "missing");
      }
      throw new EnvFileError(`The env file is not writable (${errnoName(error)}).`, "unwritable");
    }
    try {
      await fs.access(path.dirname(await fs.realpath(this.filePath)), fsConstants.W_OK);
    } catch (error) {
      throw new EnvFileError(
        `The directory of the env file is not writable (${errnoName(error)}).`,
        "unwritable",
      );
    }
  }

  async capture(keys: readonly string[] = this.writableKeys): Promise<CapturedEnv> {
    return captureKeys(await this.read(), keys);
  }

  async apply(assignments: Readonly<Record<string, string>>): Promise<void> {
    this.assertWritableKeys(Object.keys(assignments));
    await this.replace(setKeys(await this.read(), assignments));
  }

  async restore(
    captured: Readonly<Record<string, Pick<CapturedKey, "present" | "line">>>,
  ): Promise<void> {
    this.assertWritableKeys(Object.keys(captured));
    await this.replace(restoreKeys(await this.read(), captured));
  }

  /** Atomic replace (temporary file, fsync, rename, directory fsync), keeping mode and owner. */
  async replace(content: string): Promise<void> {
    const target = await fs.realpath(this.filePath);
    const before = await fs.stat(target);
    if (content === (await fs.readFile(target, "utf8"))) {
      return;
    }
    const directory = path.dirname(target);
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.cicd-updater-${process.pid}.tmp`,
    );
    const handle = await fs.open(temporary, "wx", before.mode & 0o7777);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(before.mode & 0o7777);
      try {
        await handle.chown(before.uid, before.gid);
      } catch {
        // Not permitted (not root): the file keeps the owner it was created with.
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      if (isErrno(error, "EBUSY") || isErrno(error, "EXDEV")) {
        // A single-file bind mount cannot be replaced, only rewritten.
        await this.rewriteInPlace(target, content);
        return;
      }
      throw error;
    }
    await syncDirectory(directory);
  }

  private async rewriteInPlace(target: string, content: string): Promise<void> {
    const handle = await fs.open(target, "r+");
    try {
      await handle.truncate(0);
      await handle.write(content, 0, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some file systems refuse fsync on directories; the rename itself is already atomic.
  }
}

function errnoName(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "error";
}

function isErrno(error: unknown, code: string): boolean {
  return errnoName(error) === code;
}
