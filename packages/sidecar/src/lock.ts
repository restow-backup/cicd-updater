import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "@cicd-updater/engine";

/**
 * The state directory lock (design 5.10): `<stateDir>/.lock`, created with
 * O_EXCL, holding `{ instanceId, pid, hostname, heartbeatAt }` and refreshed
 * every 15 s. A lock of another live process (heartbeat younger than 60 s, a
 * different host) makes the sidecar exit with code 75; an older one, or one
 * left by this container's previous process, is taken over.
 */

export const LOCK_FILE = ".lock";
export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 60_000;

export interface LockContent {
  instanceId: string;
  /** Identifies this process (several processes share the instance id of the state). */
  owner: string;
  pid: number;
  hostname: string;
  heartbeatAt: string;
}

export class StateLockedError extends Error {
  constructor(readonly holder: LockContent) {
    super(
      `The state directory is locked by ${holder.hostname} (pid ${holder.pid}, heartbeat ${holder.heartbeatAt}).`,
    );
    this.name = "StateLockedError";
  }
}

export class StateLock {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly file: string,
    private readonly content: LockContent,
    private readonly now: () => Date,
  ) {}

  static async acquire(options: {
    stateDir: string;
    instanceId: string;
    hostname: string;
    logger: Logger;
    now?: () => Date;
    pid?: number;
  }): Promise<StateLock> {
    const now = options.now ?? (() => new Date());
    const file = path.join(options.stateDir, LOCK_FILE);
    const content: LockContent = {
      instanceId: options.instanceId,
      owner: randomUUID(),
      pid: options.pid ?? process.pid,
      hostname: options.hostname,
      heartbeatAt: now().toISOString(),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(content));
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new StateLock(file, content, now);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      let holder: LockContent | null = null;
      try {
        holder = JSON.parse(await fs.readFile(file, "utf8")) as LockContent;
      } catch {
        holder = null;
      }
      const age = holder
        ? now().getTime() - Date.parse(holder.heartbeatAt)
        : Number.POSITIVE_INFINITY;
      const sameContainer = holder?.hostname === options.hostname;
      if (holder && !sameContainer && Number.isFinite(age) && age < STALE_MS) {
        throw new StateLockedError(holder);
      }
      options.logger.warn(
        holder
          ? `Taking over the state lock of ${holder.hostname} (pid ${holder.pid}, heartbeat ${Math.round(age / 1000)} s ago).`
          : "Taking over an unreadable state lock.",
      );
      await fs.rm(file, { force: true });
    }
    throw new Error("The state lock could not be acquired.");
  }

  /** Refresh the heartbeat every 15 s (the timer does not keep the process alive). */
  startHeartbeat(onError: (error: Error) => void): void {
    this.timer = setInterval(() => {
      this.content.heartbeatAt = this.now().toISOString();
      fs.writeFile(this.file, JSON.stringify(this.content), { mode: 0o600 }).catch(onError);
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  async release(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      const current = JSON.parse(await fs.readFile(this.file, "utf8")) as LockContent;
      if (current.owner === this.content.owner) {
        await fs.rm(this.file, { force: true });
      }
    } catch {
      // Already gone.
    }
  }
}
