import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type JournalEvent,
  type Run,
  STATUS_SCHEMA_VERSION,
  type StatusFile,
  statusFileSchema,
  summaryOf,
} from "@cicd-updater/protocol";
import { syncDirectory } from "./env-file.js";
import type { Logger } from "./ports.js";

/**
 * The sidecar's state: one document, `status.json`, in the state volume
 * (design 5.9). It is written atomically (temporary file, fsync, rename,
 * directory fsync) after every change and before the side effect that follows
 * it, so a crash never leaves a run undocumented. A file that cannot be read,
 * or that has a newer schema version, is moved aside and never overwritten;
 * the sidecar then continues idle without history (the running installation
 * is not affected by losing it).
 *
 * Derived from Restow's updater (Apache-2.0).
 */

export const STATE_FILE = "status.json";
const CORRUPT_FILES_KEPT = 5;

export function initialState(): StatusFile {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    instanceId: randomUUID(),
    phase: "idle",
    run: null,
    runContext: null,
    history: [],
    events: [],
    eventCounter: 0,
  };
}

function eventIdOf(epochMs: number, counter: number): string {
  return `${String(Math.floor(epochMs)).padStart(15, "0")}-${String(counter % 1_000_000).padStart(6, "0")}`;
}

export interface StoreLimits {
  historyLimit: number;
  eventLimit: number;
}

export type ParseResult = { ok: true; state: StatusFile } | { ok: false; reason: string };

/** Read a status document; older schema versions would be migrated here (there are none yet). */
export function parseState(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === "number" && version > STATUS_SCHEMA_VERSION) {
    return { ok: false, reason: `schema version ${version} is newer than this sidecar knows` };
  }
  const result = statusFileSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: `schema mismatch at ${issue && issue.path.length > 0 ? issue.path.join(".") : "root"}`,
    };
  }
  return { ok: true, state: result.data };
}

export class StatusStore {
  /** Name of the file the previous status.json was moved to because it was unusable. */
  recoveredFrom: string | null = null;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    readonly filePath: string,
    private doc: StatusFile,
    private readonly limits: StoreLimits,
  ) {}

  static async open(
    stateDir: string,
    logger: Logger,
    now: () => Date,
    limits: StoreLimits = { historyLimit: 20, eventLimit: 500 },
  ): Promise<StatusStore> {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const filePath = path.join(stateDir, STATE_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const store = new StatusStore(filePath, initialState(), limits);
        await store.save();
        return store;
      }
      throw error;
    }
    const parsed = parseState(raw);
    if (parsed.ok) {
      return new StatusStore(filePath, parsed.state, limits);
    }
    const store = new StatusStore(filePath, initialState(), limits);
    const aside = `${STATE_FILE}.corrupt-${now().getTime()}`;
    try {
      await fs.rename(filePath, path.join(stateDir, aside));
      store.recoveredFrom = aside;
      logger.error(
        `status.json could not be used (${parsed.reason}); moved to ${aside}. Continuing idle without history.`,
      );
    } catch (error) {
      logger.error(
        `status.json could not be used (${parsed.reason}) and could not be moved aside (${(error as Error).message}). Continuing idle without history.`,
      );
    }
    await pruneCorruptFiles(stateDir, logger);
    await store.save();
    return store;
  }

  /** The live document. Mutate it, then `await save()`. */
  get state(): StatusFile {
    return this.doc;
  }

  /** A deep copy, safe to hand out. */
  snapshot(): StatusFile {
    return structuredClone(this.doc);
  }

  /** Put a run into the history (newest first), replacing an entry with the same id. */
  recordHistory(run: Run): void {
    const summary = summaryOf(structuredClone(run));
    this.doc.history = [summary, ...this.doc.history.filter((entry) => entry.id !== run.id)].slice(
      0,
      this.limits.historyLimit,
    );
  }

  /** Append a journal event; ids sort chronologically and stay unique across restarts. */
  addEvent(event: Omit<JournalEvent, "id">, nowMs: number): JournalEvent {
    const last = this.doc.events[this.doc.events.length - 1];
    const lastMs = last ? Number(last.id.slice(0, last.id.indexOf("-"))) : 0;
    // A clock that stepped back must not reorder ids.
    const epochMs = Math.max(nowMs, Number.isFinite(lastMs) ? lastMs : 0);
    this.doc.eventCounter += 1;
    const full: JournalEvent = { ...event, id: eventIdOf(epochMs, this.doc.eventCounter) };
    this.doc.events = [...this.doc.events, full].slice(-this.limits.eventLimit);
    return full;
  }

  /** Persist the document. Writes are strictly ordered; resolves once the file is durable. */
  save(): Promise<void> {
    this.doc.history = this.doc.history.slice(0, this.limits.historyLimit);
    this.doc.events = this.doc.events.slice(-this.limits.eventLimit);
    const payload = `${JSON.stringify(this.doc)}\n`;
    const write = this.chain.then(() => writeAtomic(this.filePath, payload));
    // A failed write must not poison later writes; the caller of this write still sees the error.
    this.chain = write.catch(() => undefined);
    return write;
  }

  /** Resolves when every write started so far has finished. */
  async flush(): Promise<void> {
    await this.chain;
  }
}

export async function writeAtomic(
  filePath: string,
  payload: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  const handle = await fs.open(temporary, "w", mode);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

async function pruneCorruptFiles(stateDir: string, logger: Logger): Promise<void> {
  try {
    const names = (await fs.readdir(stateDir))
      .filter((name) => name.startsWith(`${STATE_FILE}.corrupt-`))
      .sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()));
    for (const name of names.slice(0, Math.max(0, names.length - CORRUPT_FILES_KEPT))) {
      await fs.rm(path.join(stateDir, name), { force: true });
    }
  } catch (error) {
    logger.warn(`Could not prune old unusable status files: ${(error as Error).message}`);
  }
}
