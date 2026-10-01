import {
  en,
  formatMessage,
  interpolate,
  type Messages,
  type PublicStatus,
} from "@cicd-updater/protocol";
import { createElement, useEffect, useRef, useState } from "react";
import {
  countdownOf,
  formatCountdown,
  type MaintenanceSnapshot,
  MaintenanceTracker,
  type MaintenanceView,
  pollMaintenance,
} from "./maintenance.js";

// The React-free parts stay importable from /react as well.
export {
  countdownOf,
  formatCountdown,
  type MaintenanceSnapshot,
  MaintenanceTracker,
  type MaintenanceView,
  pollMaintenance,
} from "./maintenance.js";

/**
 * Headless-first React parts for the maintenance banner and progress (design
 * 7.7). They talk only to the app's own endpoints (and, while the app is
 * down, to the public status through the edge), never to the sidecar.
 * Elements carry `data-state` and `className` hooks; no styling is imposed.
 * The polling logic itself is React-free (`/maintenance`).
 */

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
  const [snapshot, setSnapshot] = useState<MaintenanceSnapshot>(
    () => new MaintenanceTracker().snapshot,
  );
  const latest = useRef(options);
  latest.current = options;

  useEffect(
    () =>
      pollMaintenance({
        fetchMaintenance: () => latest.current.fetchMaintenance(),
        fetchPublicStatus: () => latest.current.fetchPublicStatus?.() ?? Promise.resolve(null),
        onChange: setSnapshot,
        onReload: () => (latest.current.onReload ?? (() => globalThis.location?.reload()))(),
        get idlePollMs() {
          return latest.current.idlePollMs;
        },
        get activePollMs() {
          return latest.current.activePollMs;
        },
      }),
    [],
  );

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

/**
 * The banner every signed-in user sees: countdown, progress or result. Nothing while idle.
 *
 * Only the title and the state's text are a live region (`role="status"`), so screen
 * readers announce phase changes; the countdown of a scheduled run ticks every second
 * outside it (`data-part="countdown"`) and is read only when the user moves to it.
 */
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
  let countdownText: string | null = null;
  if (snapshot.phase === "scheduled") {
    title = messages.ui.updateScheduled;
    detail = "";
    countdownText =
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
      className: props.className,
      "data-state": snapshot.phase,
      "data-outcome": view.outcome ?? undefined,
    },
    createElement(
      "span",
      { role: "status", "aria-live": "polite", "aria-atomic": "true", "data-part": "announcement" },
      createElement("strong", { "data-part": "title" }, title),
      detail ? createElement("span", { "data-part": "detail" }, ` ${detail}`) : null,
    ),
    countdownText ? createElement("span", { "data-part": "countdown" }, ` ${countdownText}`) : null,
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
