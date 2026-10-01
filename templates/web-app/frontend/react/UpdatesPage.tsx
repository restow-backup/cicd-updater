import {
  describeCode,
  formatMessage,
  interpolate,
  type Messages,
  messagesFor,
} from "@restow-backup/cicd-updater/messages";
import type { ReleasesView, StateView } from "@restow-backup/cicd-updater/protocol";
import { formatCountdown, useCountdown } from "@restow-backup/cicd-updater/react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type AdminUpdatesView, ApiError, updatesApi } from "./api.js";

/**
 * cicd-updater: the admin "Updates" page. Shows the running version, the next release
 * with its notes, a schedule form with a lead time, the live status of a run with cancel,
 * the result with acknowledge, and what to do when a run needs attention.
 *
 * Only for installation admins: your router and your backend enforce that
 * (backend/node/updates.ts). Codes (blockers, refusals, failures, steps) are translated
 * by the SDK's `messages` catalogs (en, de); the page's own sentences are in TEXT.
 *
 *   <UpdatesPage onStepUp={() => openReauthDialog()} />
 */

/** TODO(cicd-updater): translate or move into your app's i18n; set the two URLs. */
const TEXT = {
  title: "Updates",
  loading: "Loading the update status…",
  forbidden: "Only installation administrators can manage updates.",
  offline:
    "The app does not answer. While an update runs this is expected; this page reconnects by itself.",
  noSidecar: "Updates from this page are not set up on this installation.",
  manualSteps: "How to update by hand",
  manualStepsUrl: "https://docs.example.com/updating",
  runbookUrl:
    "https://github.com/restow-backup/cicd-updater/blob/main/docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention",
  runningVersion: "Running version",
  unknown: "unknown",
  blocked: "Updates are blocked until these problems are fixed on the host:",
  warnings: "Warnings:",
  currentRun: "Current update",
  versions: (from: string | null, to: string) => `Version ${from ?? "unknown"} to ${to}`,
  requestedBy: (label: string) => `Requested by ${label}`,
  abortRequested: "Abort requested; the update stops at its next check point.",
  cancel: "Cancel update",
  acknowledge: "Acknowledge",
  attentionTitle: "This update needs attention",
  attentionBody:
    "The update failed after the point of no return, and going back was not certain to be safe. The app was stopped, the backup was kept, and nothing happens automatically. An operator decides on the host whether to go back to the previous version or forward to the new one.",
  attentionSchema: {
    true: "The new version changed the database schema: the previous version must not run on it without restoring the backup.",
    false: "The database schema is unchanged; starting the previous version failed.",
    null: "It is unknown whether the database schema changed; treat it as changed.",
  },
  attentionBackup: (file: string) => `Backup: ${file}`,
  attentionCommand: "On the host, in the project directory:",
  attentionCommands: "Recovery commands recorded by the updater (review before running them)",
  attentionRunbook: "Runbook: a run ended in needs_attention",
  attentionAcknowledge: "Acknowledge only after the installation runs again.",
  available: "Available release",
  checking: "Checking for releases…",
  checkAgain: "Check for new releases",
  newest: "This installation runs the newest release.",
  nothingInstallable: "No newer release can be installed now:",
  version: "Version",
  start: "Start",
  notes: "Release notes",
  digest: (sha: string) => `release.json SHA-256 ${sha.slice(0, 16)}…`,
  schedule: "Schedule update",
  busyRun: "An update is already scheduled or running.",
  stepUp: "Please confirm your sign-in, then try again.",
  scheduled: (version: string) => `The update to ${version} is scheduled.`,
  cancelled: "The update was cancelled.",
  acknowledged: "The result was acknowledged.",
  leadTime: (seconds: number) =>
    seconds === 0
      ? "now"
      : seconds < 3600
        ? `in ${seconds / 60} minute${seconds === 60 ? "" : "s"}`
        : `in ${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`,
};

function defaultMessages(): Messages {
  return messagesFor(typeof navigator === "undefined" ? "en" : navigator.language);
}

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, "network");
}

/** One sentence for an error answer; codes go through the SDK catalogs. */
function explain(error: ApiError, messages: Messages): string {
  switch (error.code) {
    case "forbidden":
    case "unauthorized":
      return TEXT.forbidden;
    case "step_up_required":
      return TEXT.stepUp;
    case "network":
      return TEXT.offline;
    case "updater_unavailable":
      return TEXT.noSidecar;
    case "blocked":
      return [
        describeCode(messages, "problems", "blocked"),
        ...(error.body.blockers ?? []).map((b) => describeCode(messages, "blockers", b.code)),
      ].join(" ");
    case "release_refused":
      return [
        describeCode(messages, "problems", "release_refused"),
        ...(error.body.reasons ?? []).map((r) => describeCode(messages, "refusals", r)),
      ].join(" ");
    case "feed_unavailable":
      return [
        describeCode(messages, "problems", "feed_unavailable"),
        error.body.feedError ? describeCode(messages, "feedErrors", error.body.feedError) : "",
      ].join(" ");
    default:
      return describeCode(messages, "problems", error.code);
  }
}

export function UpdatesPage(props: {
  messages?: Messages;
  /** TODO(cicd-updater): open your "confirm it is you" dialog; the admin then retries. */
  onStepUp?: () => void;
}) {
  const messages = props.messages ?? defaultMessages();
  const titleId = useId();
  const [view, setView] = useState<AdminUpdatesView | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [releases, setReleases] = useState<ReleasesView | null>(null);
  const [releasesError, setReleasesError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const showState = useCallback((state: StateView | null) => {
    setView((current) => (current ? { ...current, state } : current));
    if (state) {
      setOffsetMs(Date.parse(state.serverTime) - Date.now());
    }
  }, []);

  // Poll: every 3 seconds while a run is scheduled or running or the app is down,
  // otherwise every 30 seconds. Stop when the user may not see the page.
  const pollNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    let generation = 0; // a newer tick (pollNow) supersedes one still in flight
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const mine = ++generation;
      let delay = 30_000;
      try {
        const next = await updatesApi.status();
        if (stopped || mine !== generation) {
          return;
        }
        setView(next);
        setLoadError(null);
        if (next.state) {
          setOffsetMs(Date.parse(next.state.serverTime) - Date.now());
        }
        const phase = next.state?.phase;
        delay = phase === "scheduled" || phase === "running" ? 3_000 : 30_000;
      } catch (error) {
        if (stopped || mine !== generation) {
          return;
        }
        const failure = asApiError(error);
        setLoadError(failure);
        if (failure.status === 401 || failure.status === 403) {
          return;
        }
        delay = 3_000;
      }
      timer = setTimeout(tick, delay);
    };
    pollNow.current = () => {
      clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const loadReleases = useCallback(async (refresh: boolean) => {
    setReleasesError(null);
    try {
      setReleases(await updatesApi.releases(refresh));
    } catch (error) {
      setReleasesError(asApiError(error));
    }
  }, []);

  const hasSidecar = Boolean(view?.state);
  const runningVersion = view?.state?.running.version ?? null;
  useEffect(() => {
    // Again after the running version changed (a finished update).
    if (hasSidecar) {
      void loadReleases(false);
    }
  }, [hasSidecar, runningVersion, loadReleases]);

  async function act(action: () => Promise<StateView>, done: string): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      showState(await action());
      setNotice(done);
      pollNow.current(); // follow the run at the faster pace at once
    } catch (error) {
      const failure = asApiError(error);
      if (failure.code === "step_up_required") {
        props.onStepUp?.();
      }
      setActionError(explain(failure, messages));
    } finally {
      setBusy(false);
    }
  }

  let content: ReactNode;
  if (!view) {
    content = <p>{loadError ? explain(loadError, messages) : TEXT.loading}</p>;
  } else if (!view.state) {
    content = (
      <p>
        {TEXT.noSidecar} <a href={TEXT.manualStepsUrl}>{TEXT.manualSteps}</a>
      </p>
    );
  } else {
    const state = view.state;
    const active = state.phase === "scheduled" || state.phase === "running";
    content = (
      <>
        {loadError ? <p className="updates-offline">{explain(loadError, messages)}</p> : null}
        <dl className="updates-facts">
          <dt>{TEXT.runningVersion}</dt>
          <dd>{state.running.version ?? TEXT.unknown}</dd>
        </dl>
        {state.trust.mode === "none" ? (
          <p className="updates-warning">{messages.ui.trustModeNone}</p>
        ) : null}
        {state.capabilities.blockers.length > 0 ? (
          <div className="updates-warning">
            <p>{TEXT.blocked}</p>
            <ul>
              {state.capabilities.blockers.map((blocker) => (
                <li key={blocker.code}>{describeCode(messages, "blockers", blocker.code)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.capabilities.warnings.length > 0 ? (
          <div className="updates-note">
            <p>{TEXT.warnings}</p>
            <ul>
              {state.capabilities.warnings.map((warning) => (
                <li key={warning.code}>{describeCode(messages, "warnings", warning.code)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {state.run && state.phase !== "idle" ? (
          <RunPanel
            state={state}
            offsetMs={offsetMs}
            messages={messages}
            busy={busy}
            onCancel={(runId) => act(() => updatesApi.cancel(runId), TEXT.cancelled)}
            onAcknowledge={(runId) => act(() => updatesApi.acknowledge(runId), TEXT.acknowledged)}
          />
        ) : null}
        <ReleasePanel
          releases={releases}
          error={releasesError}
          leadTimes={view.leadTimes}
          blockedReason={
            active
              ? TEXT.busyRun
              : state.capabilities.ready
                ? null
                : describeCode(messages, "problems", "blocked")
          }
          messages={messages}
          busy={busy}
          onRefresh={() => loadReleases(true)}
          onSchedule={(input) =>
            act(() => updatesApi.schedule(input), TEXT.scheduled(input.version))
          }
        />
      </>
    );
  }

  return (
    <section aria-labelledby={titleId} aria-busy={busy} className="updates-page">
      <h2 id={titleId}>{TEXT.title}</h2>
      <output aria-live="polite" className="updates-live">
        {notice}
      </output>
      {actionError ? (
        <p role="alert" className="updates-error">
          {actionError}
        </p>
      ) : null}
      {content}
    </section>
  );
}

function RunPanel(props: {
  state: StateView;
  offsetMs: number;
  messages: Messages;
  busy: boolean;
  onCancel: (runId: string) => void;
  onAcknowledge: (runId: string) => void;
}) {
  const { state, messages } = props;
  const run = state.run;
  const headingId = useId();
  const progressId = useId();
  const countdown = useCountdown(
    state.phase === "scheduled" ? (run?.startsAt ?? null) : null,
    props.offsetMs,
  );
  if (!run) {
    return null;
  }
  const finished = state.phase === "succeeded" || state.phase === "failed";
  // The live region carries the phase and the step message only: the ticking countdown
  // stays outside it, so screen readers do not announce every second.
  const detail = run.outcome
    ? messages.outcomes[run.outcome]
    : state.phase === "scheduled"
      ? ""
      : formatMessage(messages, run.message);

  return (
    <section aria-labelledby={headingId} className="updates-run" data-state={state.phase}>
      <h3 id={headingId}>{TEXT.currentRun}</h3>
      <p aria-live="polite">
        <strong>{messages.phases[state.phase]}</strong> {detail}
      </p>
      {state.phase === "scheduled" ? (
        <p>
          {countdown && countdown > 0
            ? interpolate(messages.ui.startsIn, { time: formatCountdown(countdown) })
            : messages.ui.startingNow}
        </p>
      ) : null}
      <p>
        {TEXT.versions(run.fromVersion, run.targetVersion)}.{" "}
        {TEXT.requestedBy(run.requestedBy.label)}.
      </p>
      {state.phase === "running" ? (
        <>
          <label htmlFor={progressId}>
            {interpolate(messages.ui.progress, { progress: run.progress })}
          </label>
          <progress id={progressId} max={100} value={run.progress} />
          <ol className="updates-steps">
            {run.steps
              .filter((step) => step.status !== "skipped")
              .map((step) => (
                <li key={step.id} data-status={step.status}>
                  {messages.steps[step.id]}
                </li>
              ))}
          </ol>
        </>
      ) : null}
      {run.abortRequestedAt ? <p>{TEXT.abortRequested}</p> : null}
      {run.failure ? <p>{describeCode(messages, "failures", run.failure.code)}</p> : null}
      {run.outcome === "needs_attention" ? <AttentionGuide state={state} /> : null}
      <div className="updates-actions">
        {(state.phase === "scheduled" || state.phase === "running") && !run.abortRequestedAt ? (
          <button type="button" disabled={props.busy} onClick={() => props.onCancel(run.id)}>
            {TEXT.cancel}
          </button>
        ) : null}
        {finished ? (
          <button type="button" disabled={props.busy} onClick={() => props.onAcknowledge(run.id)}>
            {TEXT.acknowledge}
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** What an admin needs when a run ended in needs_attention (docs/backups-and-recovery.md). */
function AttentionGuide(props: { state: StateView }) {
  const run = props.state.run;
  if (!run) {
    return null;
  }
  const schemaChanged = run.failure?.schemaChanged ?? null;
  return (
    <div className="updates-attention">
      <h4>{TEXT.attentionTitle}</h4>
      <p>{TEXT.attentionBody}</p>
      <p>{TEXT.attentionSchema[String(schemaChanged) as "true" | "false" | "null"]}</p>
      {run.recovery?.backup ? <p>{TEXT.attentionBackup(run.recovery.backup.file)}</p> : null}
      <p>{TEXT.attentionCommand}</p>
      <pre>
        <code>docker compose exec updater cicd-updater recover show</code>
      </pre>
      {run.recovery && run.recovery.commands.length > 0 ? (
        <details>
          <summary>{TEXT.attentionCommands}</summary>
          <pre>
            <code>{run.recovery.commands.join("\n")}</code>
          </pre>
        </details>
      ) : null}
      <p>
        <a href={TEXT.runbookUrl}>{TEXT.attentionRunbook}</a>. {TEXT.attentionAcknowledge}
      </p>
    </div>
  );
}

function ReleasePanel(props: {
  releases: ReleasesView | null;
  error: ApiError | null;
  leadTimes: readonly number[];
  /** Why scheduling is not possible now; null: it is. */
  blockedReason: string | null;
  messages: Messages;
  busy: boolean;
  onRefresh: () => void;
  onSchedule: (input: { version: string; leadSeconds: number; releaseSha256: string }) => void;
}) {
  const { releases, messages } = props;
  const headingId = useId();
  const versionId = useId();
  const leadId = useId();
  const installable = (releases?.releases ?? []).filter(
    (release) => release.refusals.length === 0 && release.releaseSha256 !== null,
  );
  const refused = (releases?.releases ?? []).filter(
    (release) => release.refusals.length > 0 && !release.refusals.includes("not_newer"),
  );
  const [version, setVersion] = useState("");
  const [leadSeconds, setLeadSeconds] = useState(props.leadTimes.includes(900) ? 900 : 0);
  const chosen =
    installable.find((release) => release.version === version) ??
    installable.find((release) => release.version === releases?.nextInstallable) ??
    installable[0];

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (chosen?.releaseSha256) {
      props.onSchedule({
        version: chosen.version,
        leadSeconds,
        releaseSha256: chosen.releaseSha256,
      });
    }
  }

  let body: ReactNode;
  if (props.error) {
    body = <p>{explain(props.error, messages)}</p>;
  } else if (!releases) {
    body = <p>{TEXT.checking}</p>;
  } else if (!chosen) {
    body = refused.length === 0 ? <p>{TEXT.newest}</p> : <p>{TEXT.nothingInstallable}</p>;
  } else {
    body = (
      <form onSubmit={submit} className="updates-form">
        <label htmlFor={versionId}>{TEXT.version}</label>
        <select
          id={versionId}
          value={chosen.version}
          onChange={(event) => setVersion(event.target.value)}
        >
          {installable.map((release) => (
            <option key={release.version} value={release.version}>
              {release.version}
            </option>
          ))}
        </select>
        <p className="updates-release">
          {chosen.notesUrl ? (
            <a href={chosen.notesUrl} target="_blank" rel="noopener noreferrer">
              {TEXT.notes}
            </a>
          ) : null}{" "}
          {chosen.releaseSha256 ? <span>{TEXT.digest(chosen.releaseSha256)}</span> : null}
        </p>
        <label htmlFor={leadId}>{TEXT.start}</label>
        <select
          id={leadId}
          value={leadSeconds}
          onChange={(event) => setLeadSeconds(Number(event.target.value))}
        >
          {props.leadTimes.map((seconds) => (
            <option key={seconds} value={seconds}>
              {TEXT.leadTime(seconds)}
            </option>
          ))}
        </select>
        <button type="submit" disabled={props.busy || props.blockedReason !== null}>
          {TEXT.schedule}
        </button>
        {props.blockedReason ? <p>{props.blockedReason}</p> : null}
      </form>
    );
  }

  return (
    <section aria-labelledby={headingId} className="updates-available">
      <h3 id={headingId}>{TEXT.available}</h3>
      {body}
      {refused.length > 0 ? (
        <ul className="updates-refused">
          {refused.map((release) => (
            <li key={release.version}>
              {release.version}:{" "}
              {release.refusals.map((code) => describeCode(messages, "refusals", code)).join(" ")}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" disabled={props.busy} onClick={props.onRefresh}>
        {TEXT.checkAgain}
      </button>
    </section>
  );
}
