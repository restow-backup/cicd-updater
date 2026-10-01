import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * The app's side of the shared token (design 7.5): its health endpoint always
 * answers readiness and adds the version (and other details) only when the
 * request carries the sidecar's token. A public version number tells an
 * attacker which known vulnerability is still open.
 */
export function createTokenVerifier(options: {
  /** The token file the sidecar writes (mounted read-only into the app). */
  tokenFile: string;
  /** How long the file content is reused (default 30000). */
  ttlMs?: number;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}): { isUpdater(authorizationHeader: string | null | undefined): Promise<boolean> } {
  const ttl = options.ttlMs ?? 30_000;
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? Date.now;
  let cached: { at: number; digest: Buffer | null } | null = null;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

  const expected = async (): Promise<Buffer | null> => {
    if (cached && now() - cached.at < ttl) {
      return cached.digest;
    }
    let token: string | null = null;
    try {
      token = (await read(options.tokenFile)).trim() || null;
    } catch {
      token = null;
    }
    cached = { at: now(), digest: token ? digest(token) : null };
    return cached.digest;
  };

  return {
    async isUpdater(header) {
      const wanted = await expected();
      const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
      // Compare something either way, so the timing does not tell whether a token was sent.
      const provided = digest(match?.[1] ?? "");
      if (!wanted) {
        timingSafeEqual(provided, provided);
        return false;
      }
      return timingSafeEqual(wanted, provided) && match !== null;
    },
  };
}
