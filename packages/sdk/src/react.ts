import {
  en,
  formatMessage,
  interpolate,
  type Messages,
  type Phase,
  type PublicStatus,
} from "@cicd-updater/protocol";
import { createElement, useEffect, useRef, useState } from "react";

/**
 * Headless-first React parts for the maintenance banner and progress (design
 * 7.7). They talk only to the app's own endpoints (and, while the app is
 * down, to the public status through the edge), never to the sidecar.
 * Elements carry `data-state` and `className` hooks; no styling is imposed.
 */

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

const RELOAD_DELAY_MS = 2500;
const RELOAD_GUARD_MS = 60_000;
const STALE_FAILURE_MS = 24 * 3600 * 1000;

/**
 * The polling logic without React (testable): clock offset, what to show and
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

export interface UseMaintenanceOptions {
  /** The app's own endpoint (every signed-in user may read it). */
  fetchMaintenance: () => Promise<MaintenanceView>;
  /** The public status through the edge, used while the app is down. */
  fetchPublicStatus?: () => Promise<PublicStatus | null>;
  idlePollMs?: number;
  activePollMs?: number;
  onReload?: () => void;
}

export function useMaintenance(options: UseMaintenanceOptions): MaintenanceSnapshot {
  const tracker = useRef(new MaintenanceTracker());
  const [snapshot, setSnapshot] = useState<MaintenanceSnapshot>(tracker.current.snapshot);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      const { fetchMaintenance, fetchPublicStatus, onReload } = latest.current;
      let view: MaintenanceView | null = null;
      let reachable = true;
      try {
        view = await fetchMaintenance();
      } catch {
        reachable = false;
        view = fetchPublicStatus ? await fetchPublicStatus().catch(() => null) : null;
      }
      if (cancelled) {
        return;
      }
      const { reload } = tracker.current.observe(view, Date.now(), reachable);
      setSnapshot(tracker.current.snapshot);
      if (reload) {
        setTimeout(() => (onReload ?? (() => globalThis.location?.reload()))(), RELOAD_DELAY_MS);
      }
      timer = setTimeout(
        poll,
        tracker.current.nextPollMs(
          latest.current.idlePollMs ?? 30_000,
          latest.current.activePollMs ?? 2000,
        ),
      );
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return snapshot;
}

/** A ticking countdown in seconds (null without a start time). */
export function useCountdown(startsAt: string | null, offsetMs: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startsAt) {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startsAt]);
  return startsAt ? countdownOf(startsAt, offsetMs, now) : null;
}

export interface PartProps {
  snapshot: MaintenanceSnapshot;
  messages?: Messages;
  className?: string;
}

/** The banner every signed-in user sees: countdown, progress or result. Nothing while idle. */
export function MaintenanceBanner(props: PartProps) {
  const messages = props.messages ?? en;
  const { snapshot } = props;
  const view = snapshot.view;
  const countdown = useCountdown(
    snapshot.phase === "scheduled" ? (view?.startsAt ?? null) : null,
    snapshot.offsetMs,
  );
  if (!view || snapshot.phase === "idle") {
    return null;
  }
  let title = messages.phases[snapshot.phase];
  let detail = formatMessage(messages, view.message);
  if (snapshot.phase === "scheduled") {
    title = messages.ui.updateScheduled;
    detail =
      countdown && countdown > 0
        ? interpolate(messages.ui.startsIn, { time: formatCountdown(countdown) })
        : messages.ui.startingNow;
  } else if (snapshot.phase === "running") {
    title = messages.ui.updateRunning;
  } else if (snapshot.phase === "succeeded") {
    title = messages.ui.updateSucceeded;
  } else if (snapshot.phase === "failed") {
    title = messages.ui.updateFailed;
    detail = view.outcome ? messages.outcomes[view.outcome] : detail;
  }
  return createElement(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      className: props.className,
      "data-state": snapshot.phase,
      "data-outcome": view.outcome ?? undefined,
    },
    createElement("strong", { "data-part": "title" }, title),
    detail ? createElement("span", { "data-part": "detail" }, ` ${detail}`) : null,
  );
}

/** Progress bar and step list of a running (or finished) run. */
export function UpdateProgress(props: PartProps) {
  const messages = props.messages ?? en;
  const view = props.snapshot.view;
  if (!view || view.steps.length === 0) {
    return null;
  }
  return createElement(
    "div",
    { className: props.className, "data-state": props.snapshot.phase },
    createElement(
      "div",
      {
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": view.progress,
        "data-part": "bar",
      },
      createElement("div", { "data-part": "fill", style: { width: `${view.progress}%` } }),
    ),
    createElement(
      "p",
      { "data-part": "progress" },
      interpolate(messages.ui.progress, { progress: view.progress }),
    ),
    createElement(
      "ol",
      { "data-part": "steps" },
      ...view.steps
        .filter((step) => step.status !== "skipped")
        .map((step) =>
          createElement(
            "li",
            { key: step.id, "data-status": step.status },
            messages.steps[step.id] ?? step.id,
          ),
        ),
    ),
  );
}
