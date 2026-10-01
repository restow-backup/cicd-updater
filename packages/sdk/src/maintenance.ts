import type { Phase, PublicStatus } from "@cicd-updater/protocol";

/**
 * The maintenance banner's logic without React (design 7.7): clock offset,
 * what to show, when to poll and when to reload. Any runtime with `fetch`
 * and timers (browsers, Vue, Svelte, plain DOM); `/react` builds on it.
 */

/** What the app's own maintenance endpoint returns (the public status shape). */
export type MaintenanceView = PublicStatus;

export interface MaintenanceSnapshot {
  view: MaintenanceView | null;
  /** The app's own endpoint answered the last poll. */
  apiReachable: boolean;
  /** Server time minus local time, in ms (largest of the last 8 samples). */
  offsetMs: number;
  phase: Phase;
  /** Seconds until a scheduled run starts; null otherwise. */
  countdownSeconds: number | null;
}

/** How long the page waits before it reloads after a successful run. */
export const RELOAD_DELAY_MS = 2500;
const RELOAD_GUARD_MS = 60_000;
const STALE_FAILURE_MS = 24 * 3600 * 1000;

/**
 * The polling logic (testable without timers): clock offset, what to show and
 * when to reload. A failed run older than 24 hours is not announced to a page
 * that did not see it running; a succeeded run reloads the page once.
 */
export class MaintenanceTracker {
  private samples: number[] = [];
  private seenRunning = new Set<string>();
  private lastReload = Number.NEGATIVE_INFINITY;
  snapshot: MaintenanceSnapshot = {
    view: null,
    apiReachable: true,
    offsetMs: 0,
    phase: "idle",
    countdownSeconds: null,
  };

  /** Record an answer; returns whether the page should reload (after RELOAD_DELAY_MS). */
  observe(
    view: MaintenanceView | null,
    localNow: number,
    apiReachable: boolean,
  ): { reload: boolean } {
    if (view?.serverTime) {
      this.samples.push(Date.parse(view.serverTime) - localNow);
      this.samples = this.samples.slice(-8);
    }
    const offsetMs = this.samples.length > 0 ? Math.max(...this.samples) : 0;
    let shown = view;
    if (view?.runId && (view.phase === "scheduled" || view.phase === "running")) {
      this.seenRunning.add(view.runId);
    }
    if (view?.phase === "failed" && view.runId && !this.seenRunning.has(view.runId)) {
      const finished = view.finishedAt ? Date.parse(view.finishedAt) : Number.NaN;
      if (Number.isFinite(finished) && localNow + offsetMs - finished > STALE_FAILURE_MS) {
        shown = { ...view, phase: "idle" };
      }
    }
    let reload = false;
    if (
      view?.phase === "succeeded" &&
      view.runId &&
      this.seenRunning.has(view.runId) &&
      localNow - this.lastReload > RELOAD_GUARD_MS
    ) {
      this.lastReload = localNow;
      this.seenRunning.delete(view.runId);
      reload = true;
    }
    const phase = shown?.phase ?? "idle";
    this.snapshot = {
      view: shown,
      apiReachable,
      offsetMs,
      phase,
      countdownSeconds:
        phase === "scheduled" && shown?.startsAt
          ? countdownOf(shown.startsAt, offsetMs, localNow)
          : null,
    };
    return { reload };
  }

  /** How long until the next poll. */
  nextPollMs(idlePollMs: number, activePollMs: number): number {
    const phase = this.snapshot.phase;
    return phase === "scheduled" || phase === "running" || !this.snapshot.apiReachable
      ? activePollMs
      : idlePollMs;
  }
}

/** Seconds until `startsAt` on the server's clock, never negative. */
export function countdownOf(
  startsAt: string,
  offsetMs: number,
  localNow: number = Date.now(),
): number {
  return Math.max(0, Math.round((Date.parse(startsAt) - (localNow + offsetMs)) / 1000));
}

/** `75` -> `1:15`, `3725` -> `1:02:05`. */
export function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export interface MaintenancePollOptions {
  /** The app's own endpoint (every signed-in user may read it). */
  fetchMaintenance: () => Promise<MaintenanceView>;
  /** The public status through the edge, used while the app is down. */
  fetchPublicStatus?: () => Promise<PublicStatus | null>;
  /** Called after every poll with the new snapshot. */
  onChange: (snapshot: MaintenanceSnapshot) => void;
  /** Poll interval while nothing is scheduled or running. Default 30 000 ms. */
  idlePollMs?: number;
  /** Poll interval while a run is scheduled or running, or the app is down. Default 2000 ms. */
  activePollMs?: number;
  /** Called RELOAD_DELAY_MS after a run this page saw succeeded. Default: `location.reload()`. */
  onReload?: () => void;
  /** Clock and timers, for tests. */
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * Poll until stopped: the app's endpoint first, the public status while the app
 * does not answer. Returns a function that stops polling (also a pending reload).
 *
 *   const stop = pollMaintenance({ fetchMaintenance, fetchPublicStatus, onChange: render });
 */
export function pollMaintenance(options: MaintenancePollOptions): () => void {
  const tracker = new MaintenanceTracker();
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false;
  let pollTimer: unknown = null;
  let reloadTimer: unknown = null;

  const poll = async (): Promise<void> => {
    pollTimer = null;
    let view: MaintenanceView | null = null;
    let reachable = true;
    try {
      view = await options.fetchMaintenance();
    } catch {
      reachable = false;
      view = options.fetchPublicStatus ? await options.fetchPublicStatus().catch(() => null) : null;
    }
    if (stopped) {
      return;
    }
    const { reload } = tracker.observe(view, now(), reachable);
    options.onChange(tracker.snapshot);
    if (reload) {
      reloadTimer = setTimer(
        () => (options.onReload ?? (() => globalThis.location?.reload()))(),
        RELOAD_DELAY_MS,
      );
    }
    if (!stopped) {
      pollTimer = setTimer(
        () => void poll(),
        tracker.nextPollMs(options.idlePollMs ?? 30_000, options.activePollMs ?? 2000),
      );
    }
  };
  void poll();

  return () => {
    stopped = true;
    for (const timer of [pollTimer, reloadTimer]) {
      if (timer !== null) {
        clearTimer(timer);
      }
    }
  };
}
