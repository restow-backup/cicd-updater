import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "@cicd-updater/engine";

/**
 * The shared token between the app and the sidecar (design 6.1, 8.7). The
 * sidecar generates it into `<sharedDir>/token` (64 hex characters, mode 0640,
 * owner root, group `auth.tokenGroupId`), or reads an operator-provided file.
 * It is never logged, never returned and never stored anywhere else.
 */

export const TOKEN_FILE_NAME = "token";
const GENERATED = /^[0-9a-f]{64}$/;
export const OPERATOR_TOKEN = /^[A-Za-z0-9._~+/=-]{32,512}$/;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/** Read an operator token file; throws TokenError with the path (never the content). */
export async function readOperatorToken(file: string): Promise<string> {
  let value: string;
  try {
    value = (await fs.readFile(file, "utf8")).trim();
  } catch (error) {
    throw new TokenError(
      `auth.tokenFile ${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
    );
  }
  if (!OPERATOR_TOKEN.test(value)) {
    throw new TokenError(
      `auth.tokenFile ${file} does not hold a token of 32 to 512 characters [A-Za-z0-9._~+/=-].`,
    );
  }
  return value;
}

/** Load the generated token, creating it when missing or unusable; repair its mode and group. */
export async function loadOrCreateToken(
  sharedDir: string,
  groupId: number,
  logger: Logger,
): Promise<string> {
  await fs.mkdir(sharedDir, { recursive: true, mode: 0o750 });
  const file = path.join(sharedDir, TOKEN_FILE_NAME);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (GENERATED.test(existing)) {
      await fs.chmod(file, 0o640).catch(() => undefined);
      await fs.chown(file, 0, groupId).catch(() => undefined);
      return existing;
    }
    logger.warn(`${file} does not hold a token; a new one is generated.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const token = randomBytes(32).toString("hex");
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", 0o640);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(0o640);
    await handle.chown(0, groupId).catch(() => undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  return token;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison (both sides hashed first, so the length does not leak either). */
export function tokensEqual(expected: string, provided: string): boolean {
  return timingSafeEqual(digest(expected), digest(provided));
}

/** Whether an `Authorization` header carries the token as `Bearer <token>`. */
export function isAuthorized(header: string | null | undefined, token: string): boolean {
  if (!header) {
    tokensEqual(token, "");
    return false;
  }
  const prefix = "bearer ";
  if (header.length <= prefix.length || header.slice(0, prefix.length).toLowerCase() !== prefix) {
    // Still compare something, so the time does not depend on the scheme being right.
    tokensEqual(token, header);
    return false;
  }
  return tokensEqual(token, header.slice(prefix.length).trim());
}

/** The hostname of this process (lock owner). */
export function hostname(): string {
  return process.env.HOSTNAME ?? os.hostname();
}
