// @ts-check
/**
 * cicd-updater: the maintenance banner and the admin "Updates" panel for apps without
 * React. One ES module, no build step, no dependency. It talks to YOUR app's endpoints
 * (backend/node/updates.ts, backend/python/updates.py) and, while the app is down for the
 * update, to the sidecar's public status through your edge (/public/v1/status).
 *
 *   <link rel="stylesheet" href="/static/updates.css">
 *   <div id="update-banner"></div>                     every signed-in page
 *   <section id="updates"></section>                    the admin page
 *   <script type="module">
 *     import { mountMaintenanceBanner, mountUpdatesPanel } from "/static/updates-widget.js";
 *     mountMaintenanceBanner(document.getElementById("update-banner"));
 *     mountUpdatesPanel(document.getElementById("updates"), {
 *       onStepUp: () => location.assign("/reauth?next=/admin/updates"), // TODO(cicd-updater)
 *     });
 *   </script>
 *
 * Texts: English by default (copies of the SDK's `en` and `adminEn`). A bundled app passes
 * the SDK's catalogs for another language, and gets the texts of every code with them:
 *
 *   import { adminDe, de } from "@restow-backup/cicd-updater/messages";
 *   mountMaintenanceBanner(banner, { messages: de });
 *   mountUpdatesPanel(panel, { messages: de, texts: adminDe });
 *
 * Without `messages`, blockers, refusals and failures are shown as "Status code <code>".
 * TODO(cicd-updater): without a bundler, translate CODES and ADMIN below.
 *
 * Everything is rendered with textContent (never innerHTML), and the elements are built
 * once and updated in place, so keyboard focus survives the polling.
 */

/** @typedef {import("@restow-backup/cicd-updater/protocol").PublicStatus} MaintenanceView */
/** @typedef {import("@restow-backup/cicd-updater/protocol").StateView} StateView */
/** @typedef {import("@restow-backup/cicd-updater/protocol").ReleasesView} ReleasesView */
/** @typedef {import("@restow-backup/cicd-updater/messages").Messages} Messages */
/** @typedef {import("@restow-backup/cicd-updater/messages").AdminMessages} AdminMessages */
/**
 * The parts of a `Messages` catalog the widget needs without one.
 * @typedef {{ ui: Record<string, string>, outcomes: Record<string, string>, steps: Record<string, string> }} CodeTexts
 */
/** @typedef {"failures" | "blockers" | "warnings" | "refusals" | "problems"} CodeKind */
/** @typedef {{ state: StateView | null, leadTimes: number[], stepUpMaxAgeSeconds: number }} AdminUpdatesView */

/** @type {CodeTexts} English defaults: a copy of the SDK's `en` (the parts used here). */
const CODES = {
  ui: {
    unknownCode: "Status code {code}",
    updateScheduled: "An update is scheduled.",
    updateRunning: "An update is in progress.",
    updateSucceeded: "The update finished.",
    updateFailed: "The update failed.",
    startsIn: "Starts in {time}",
    startingNow: "Starting now",
    progress: "{progress} % done",
    trustModeNone: "Signatures are not checked on this installation.",
  },
  outcomes: {
    succeeded: "The new version is running.",
    unchanged: "Nothing was changed; the previous version kept running.",
    rolled_back: "The update was rolled back; the previous version is running again.",
    needs_attention: "The update needs attention from an administrator.",
  },
  steps: {
    prepare: "Preparing",
    fetch: "Downloading and verifying",
    backup: "Backing up",
    stop: "Stopping services",
    migrate: "Migrating",
    start: "Starting the new version",
    health: "Checking health",
    smoke: "Running checks",
    finish: "Cleaning up",
  },
};

/** @type {AdminMessages} English defaults: a copy of the SDK's `adminEn`. */
const ADMIN = {
  locale: "en",
  title: "Updates",
  loading: "Loading the update status…",
  forbidden: "Only installation administrators can manage updates.",
  offline:
    "The app does not answer. While an update runs this is expected; this page reconnects by itself.",
  noSidecar: "Updates from this page are not set up on this installation.",
  manualSteps: "How to update by hand",
  runningVersion: "Running version",
  unknownVersion: "unknown",
  blocked: "Updates are blocked until these problems are fixed on the host:",
  warnings: "Warnings:",
  currentRun: "Current update",
  versions: "Version {from} to {to}",
  requestedBy: "Requested by {label}",
  abortRequested: "Abort requested; the update stops at its next check point.",
  cancel: "Cancel update",
  acknowledge: "Acknowledge",
  progressLabel: "Progress",
  attentionTitle: "This update needs attention",
  attentionBody:
    "The update failed after the point of no return, and going back was not certain to be safe. The app was stopped, the backup was kept, and nothing happens automatically. An operator decides on the host whether to go back to the previous version or forward to the new one.",
  attentionSchemaChanged:
    "The new version changed the database schema: the previous version must not run on it without restoring the backup.",
  attentionSchemaUnchanged:
    "The database schema is unchanged; starting the previous version failed.",
  attentionSchemaUnknown: "It is unknown whether the database schema changed; treat it as changed.",
  attentionBackup: "Backup: {file}",
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
  releaseDigest: "release.json SHA-256 {sha}…",
  schedule: "Schedule update",
  busyRun: "An update is already scheduled or running.",
  stepUp: "Please confirm your sign-in, then try again.",
  requestFailed: "The request failed:",
  scheduled: "The update to {version} is scheduled.",
  cancelled: "The update was cancelled, or its abort was requested.",
  acknowledged: "The result was acknowledged.",
  leadTimeNow: "now",
  leadTimeMinute: "in 1 minute",
  leadTimeMinutes: "in {count} minutes",
  leadTimeHour: "in 1 hour",
  leadTimeHours: "in {count} hours",
};

/** Replace `{name}` placeholders, as the SDK's interpolate. @param {string} template @param {Record<string, string | number>} params */
function interpolate(template, params) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, /** @type {string} */ name) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

/** The banner title of a phase. @param {CodeTexts} codes @param {string} phase */
function phaseTitle(codes, phase) {
  const key = {
    scheduled: "updateScheduled",
    running: "updateRunning",
    succeeded: "updateSucceeded",
    failed: "updateFailed",
  }[phase];
  return (key && codes.ui[key]) ?? "";
}

/** As the SDK's formatLeadTime. @param {AdminMessages} texts @param {number} seconds */
function leadTimeText(texts, seconds) {
  if (seconds <= 0) {
    return texts.leadTimeNow;
  }
  if (seconds < 3600 || seconds % 3600 !== 0) {
    const count = Math.round(seconds / 60);
    return count === 1 ? texts.leadTimeMinute : interpolate(texts.leadTimeMinutes, { count });
  }
  const count = seconds / 3600;
  return count === 1 ? texts.leadTimeHour : interpolate(texts.leadTimeHours, { count });
}

/** `75` -> `1:15`, `3725` -> `1:02:05` (as the SDK's formatCountdown). @param {number} seconds */
function formatCountdown(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (/** @type {number} */ value) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * @param {CodeTexts} codes
 * @param {CodeKind} kind
 * @param {string} code
 */
function describe(codes, kind, code) {
  const table = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (codes))[kind];
  const text =
    table && typeof table === "object"
      ? /** @type {Record<string, unknown>} */ (table)[code]
      : undefined;
  return typeof text === "string" ? text : interpolate(codes.ui.unknownCode ?? "{code}", { code });
}

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {string} [text]
 */
function el(tag, attributes = {}, text = "") {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  node.textContent = text;
  return node;
}

/** @param {Element} node @param {boolean} shown */
function show(node, shown) {
  node.toggleAttribute("hidden", !shown);
}

// ---------------------------------------------------------------------------
// The banner (every signed-in user)
// ---------------------------------------------------------------------------

/**
 * The maintenance banner: countdown, progress, result. After a successful update this
 * page saw running, it reloads once (after 2.5 seconds), so users get the new frontend.
 *
 * @param {HTMLElement | null} root
 * @param {{ api?: string, publicStatusUrl?: string, messages?: Messages,
 *   idlePollMs?: number, activePollMs?: number, onReload?: () => void }} [options]
 * @returns {() => void} stops polling
 */
export function mountMaintenanceBanner(root, options = {}) {
  if (!root) {
    return () => {};
  }
  const api = options.api ?? "/api";
  const publicStatusUrl = options.publicStatusUrl ?? "/public/v1/status";
  /** @type {CodeTexts} */
  const codes = options.messages ?? CODES;
  const banner = el("div", { class: "update-banner" });
  // Only the title is a live region: the countdown ticks every second outside it.
  const title = el("strong", { "data-part": "title", "aria-live": "polite" });
  const detail = el("span", { "data-part": "detail" });
  banner.append(title, " ", detail);
  const progress = el("div", { class: "update-progress" });
  const bar = el("div", {
    role: "progressbar",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "data-part": "bar",
  });
  const fill = el("div", { "data-part": "fill" });
  bar.append(fill);
  const progressText = el("p", { "data-part": "progress" });
  const steps = el("ol", { "data-part": "steps" });
  progress.append(bar, progressText, steps);
  show(banner, false);
  show(progress, false);
  root.append(banner, progress);

  /** @type {number[]} */
  let samples = [];
  const seenActive = new Set();
  let lastReload = Number.NEGATIVE_INFINITY;
  /** @type {MaintenanceView | null} */
  let view = null;
  let offsetMs = 0;
  let reachable = true;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer;

  function render() {
    const phase = view?.phase ?? "idle";
    show(banner, view !== null && phase !== "idle");
    show(progress, phase === "running" && (view?.steps.length ?? 0) > 0);
    if (!view || phase === "idle") {
      return;
    }
    banner.dataset.state = phase;
    if (view.outcome) {
      banner.dataset.outcome = view.outcome;
    } else {
      delete banner.dataset.outcome;
    }
    title.textContent = phaseTitle(codes, phase);
    if (phase === "scheduled" && view.startsAt) {
      const seconds = Math.max(
        0,
        Math.round((Date.parse(view.startsAt) - (Date.now() + offsetMs)) / 1000),
      );
      detail.textContent =
        seconds > 0
          ? interpolate(codes.ui.startsIn ?? "", { time: formatCountdown(seconds) })
          : (codes.ui.startingNow ?? "");
    } else if (view.outcome) {
      detail.textContent = codes.outcomes[view.outcome] ?? "";
    } else {
      detail.textContent = codes.steps[view.step ?? "prepare"] ?? "";
    }
    bar.setAttribute("aria-valuenow", String(view.progress));
    fill.style.width = `${view.progress}%`;
    progressText.textContent = interpolate(codes.ui.progress ?? "", { progress: view.progress });
    steps.replaceChildren(
      ...view.steps
        .filter((step) => step.status !== "skipped")
        .map((step) => el("li", { "data-status": step.status }, codes.steps[step.id] ?? step.id)),
    );
  }

  /** @param {MaintenanceView | null} next @param {boolean} apiReachable */
  function observe(next, apiReachable) {
    const localNow = Date.now();
    reachable = apiReachable;
    if (next?.serverTime) {
      samples = [...samples, Date.parse(next.serverTime) - localNow].slice(-8);
      // Network delay only makes samples smaller: the largest is closest to the truth.
      offsetMs = Math.max(...samples);
    }
    view = next;
    if (next?.runId && (next.phase === "scheduled" || next.phase === "running")) {
      seenActive.add(next.runId);
    }
    // A failure this page never saw running and older than 24 hours is not news.
    if (next?.phase === "failed" && next.runId && !seenActive.has(next.runId)) {
      const finished = next.finishedAt ? Date.parse(next.finishedAt) : Number.NaN;
      if (Number.isFinite(finished) && localNow + offsetMs - finished > 24 * 3600_000) {
        view = { ...next, phase: "idle" };
      }
    }
    if (
      next?.phase === "succeeded" &&
      next.runId &&
      seenActive.has(next.runId) &&
      localNow - lastReload > 60_000
    ) {
      lastReload = localNow;
      seenActive.delete(next.runId);
      setTimeout(options.onReload ?? (() => location.reload()), 2500);
    }
    render();
  }

  async function poll() {
    /** @type {MaintenanceView | null} */
    let next = null;
    let apiReachable = true;
    try {
      const response = await fetch(`${api}/maintenance`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      next = /** @type {MaintenanceView} */ (await response.json());
    } catch {
      apiReachable = false;
      next = await fetch(publicStatusUrl, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    }
    if (stopped) {
      return;
    }
    observe(next, apiReachable);
    const phase = view?.phase ?? "idle";
    const active = phase === "scheduled" || phase === "running" || !reachable;
    pollTimer = setTimeout(
      poll,
      active ? (options.activePollMs ?? 2000) : (options.idlePollMs ?? 30_000),
    );
  }

  const tick = setInterval(() => {
    if (view?.phase === "scheduled") {
      render();
    }
  }, 1000);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(tick);
  };
}

// ---------------------------------------------------------------------------
// The admin panel
// ---------------------------------------------------------------------------

/**
 * The admin "Updates" panel: running version, next release with notes, schedule with a
 * lead time, live status with cancel, result with acknowledge, needs_attention guidance.
 *
 * @param {HTMLElement | null} root
 * @param {{ api?: string, messages?: Messages, texts?: AdminMessages, onStepUp?: () => void }} [options]
 * @returns {() => void} stops polling
 */
export function mountUpdatesPanel(root, options = {}) {
  if (!root) {
    return () => {};
  }
  const api = options.api ?? "/api";
  /** @type {CodeTexts} */
  const codes = options.messages ?? CODES;
  const texts = options.texts ?? ADMIN;

  const heading = el("h2", { id: "updates-title" }, texts.title);
  root.setAttribute("aria-labelledby", "updates-title");
  root.classList.add("updates-page");
  const live = el("output", { "aria-live": "polite", class: "updates-live" });
  const alert = el("p", { role: "alert", class: "updates-error" });
  const status = el("p", {}, texts.loading);
  const facts = el("p", { class: "updates-facts" });
  const warning = el("div", { class: "updates-warning" });

  const run = el("section", { class: "updates-run", "aria-labelledby": "updates-run-title" });
  const runLive = el("p", { "aria-live": "polite" });
  const runCountdown = el("p");
  const runInfo = el("p");
  const runProgress = el("progress", { max: "100", "aria-label": texts.progressLabel });
  const runAttention = el("div", { class: "updates-attention" });
  runAttention.append(
    el("h4", {}, texts.attentionTitle),
    el("p", {}, texts.attentionBody),
    el("p", {}, texts.attentionCommand),
    el("pre", {}, "docker compose exec updater cicd-updater recover show"),
    el("p", {}, texts.attentionAcknowledge),
  );
  const cancel = el("button", { type: "button" }, texts.cancel);
  const acknowledge = el("button", { type: "button" }, texts.acknowledge);
  run.append(
    el("h3", { id: "updates-run-title" }, texts.currentRun),
    runLive,
    runCountdown,
    runInfo,
    runProgress,
    runAttention,
    cancel,
    acknowledge,
  );

  const available = el("section", {
    class: "updates-available",
    "aria-labelledby": "updates-available-title",
  });
  const releaseStatus = el("p", {}, texts.checking);
  const form = el("form", { class: "updates-form" });
  const versionSelect = /** @type {HTMLSelectElement} */ (el("select", { id: "updates-version" }));
  const leadSelect = /** @type {HTMLSelectElement} */ (el("select", { id: "updates-lead" }));
  const notes = /** @type {HTMLAnchorElement} */ (
    el("a", { target: "_blank", rel: "noopener noreferrer" }, texts.notes)
  );
  const submit = el("button", { type: "submit" }, texts.schedule);
  const submitHint = el("p");
  form.append(
    el("label", { for: "updates-version" }, texts.version),
    versionSelect,
    notes,
    el("label", { for: "updates-lead" }, texts.start),
    leadSelect,
    submit,
    submitHint,
  );
  const refused = el("ul", { class: "updates-refused" });
  const refresh = el("button", { type: "button" }, texts.checkAgain);
  available.append(
    el("h3", { id: "updates-available-title" }, texts.available),
    releaseStatus,
    form,
    refused,
    refresh,
  );
  root.replaceChildren(heading, live, alert, status, facts, warning, run, available);
  for (const node of [alert, facts, warning, run, available, form]) {
    show(node, false);
  }

  /** @type {StateView | null} */
  let state = null;
  /** @type {ReleasesView | null} */
  let releases = null;
  let offsetMs = 0;
  let busy = false;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer;

  /**
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function call(method, path, body) {
    const response = await fetch(`${api}${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      // POST bodies are always JSON. TODO(cicd-updater): add your CSRF header if you use one.
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(String(answer.code ?? response.status)), {
        status: response.status,
        body: answer,
      });
    }
    return answer;
  }

  /** @param {unknown} error */
  function explain(error) {
    const { status: code, body } = /** @type {{ status?: number, body?: any }} */ (error);
    const problem = String(body?.code ?? "network");
    if (code === 401 || code === 403) {
      return problem === "step_up_required" ? texts.stepUp : texts.forbidden;
    }
    if (problem === "network" || problem === "updater_unavailable") {
      return problem === "network" ? texts.offline : texts.noSidecar;
    }
    const extra = [
      ...(body?.blockers ?? []).map((/** @type {{ code: string }} */ b) =>
        describe(codes, "blockers", b.code),
      ),
      ...(body?.reasons ?? []).map((/** @type {string} */ r) => describe(codes, "refusals", r)),
    ];
    return [describe(codes, "problems", problem), ...extra].join(" ");
  }

  function render() {
    show(status, state === null);
    if (!state) {
      return;
    }
    const current = state;
    const phase = current.phase;
    const active = phase === "scheduled" || phase === "running";
    show(facts, true);
    facts.textContent = `${texts.runningVersion}: ${current.running.version ?? texts.unknownVersion}`;

    const problems = [
      ...(current.trust.mode === "none" ? [codes.ui.trustModeNone ?? ""] : []),
      ...current.capabilities.blockers.map((b) => describe(codes, "blockers", b.code)),
    ];
    show(warning, problems.length > 0);
    const list = el("ul");
    list.append(...problems.map((text) => el("li", {}, text)));
    warning.replaceChildren(
      ...(current.capabilities.blockers.length > 0 ? [el("p", {}, texts.blocked)] : []),
      list,
    );

    const currentRun = phase === "idle" ? null : current.run;
    show(run, currentRun !== null);
    if (currentRun) {
      run.dataset.state = phase;
      const outcome = currentRun.outcome ? (codes.outcomes[currentRun.outcome] ?? "") : "";
      const failure = currentRun.failure
        ? describe(codes, "failures", currentRun.failure.code)
        : "";
      runLive.textContent = `${phaseTitle(codes, phase)} ${outcome || (phase === "running" ? (codes.steps[currentRun.step ?? "prepare"] ?? "") : "")} ${failure}`;
      const seconds = Math.max(
        0,
        Math.round((Date.parse(currentRun.startsAt) - (Date.now() + offsetMs)) / 1000),
      );
      show(runCountdown, phase === "scheduled");
      runCountdown.textContent =
        seconds > 0
          ? interpolate(codes.ui.startsIn ?? "", { time: formatCountdown(seconds) })
          : (codes.ui.startingNow ?? "");
      runInfo.textContent = `${interpolate(texts.versions, {
        from: currentRun.fromVersion ?? texts.unknownVersion,
        to: currentRun.targetVersion,
      })}. ${interpolate(texts.requestedBy, { label: currentRun.requestedBy.label })}.${currentRun.abortRequestedAt ? ` ${texts.abortRequested}` : ""}`;
      show(runProgress, phase === "running");
      runProgress.setAttribute("value", String(currentRun.progress));
      show(runAttention, currentRun.outcome === "needs_attention");
      show(cancel, active && !currentRun.abortRequestedAt);
      show(acknowledge, !active);
      cancel.toggleAttribute("disabled", busy);
      acknowledge.toggleAttribute("disabled", busy);
    }

    show(available, true);
    const installable = (releases?.releases ?? []).filter(
      (release) => release.refusals.length === 0 && release.releaseSha256 !== null,
    );
    const refusedReleases = (releases?.releases ?? []).filter(
      (release) => release.refusals.length > 0 && !release.refusals.includes("not_newer"),
    );
    show(releaseStatus, installable.length === 0);
    if (releases && installable.length === 0) {
      releaseStatus.textContent =
        refusedReleases.length > 0 ? texts.nothingInstallable : texts.newest;
    }
    show(form, installable.length > 0);
    const chosen =
      installable.find((release) => release.version === versionSelect.value) ?? installable[0];
    notes.href = chosen?.notesUrl ?? "";
    show(notes, Boolean(chosen?.notesUrl));
    const blockedReason = active
      ? texts.busyRun
      : current.capabilities.ready
        ? ""
        : describe(codes, "problems", "blocked");
    submit.toggleAttribute("disabled", busy || blockedReason !== "");
    submitHint.textContent = blockedReason;
    refresh.toggleAttribute("disabled", busy);
    refused.replaceChildren(
      ...refusedReleases.map((release) =>
        el(
          "li",
          {},
          `${release.version}: ${release.refusals.map((code) => describe(codes, "refusals", code)).join(" ")}`,
        ),
      ),
    );
  }

  /** @param {readonly number[]} leadTimes */
  function fillLeadTimes(leadTimes) {
    if (leadSelect.options.length > 0) {
      return;
    }
    for (const seconds of leadTimes) {
      const option = /** @type {HTMLOptionElement} */ (
        el("option", { value: String(seconds) }, leadTimeText(texts, seconds))
      );
      option.selected = seconds === 900;
      leadSelect.append(option);
    }
  }

  /** @param {boolean} refreshFeed */
  async function loadReleases(refreshFeed) {
    releaseStatus.textContent = texts.checking;
    show(releaseStatus, true);
    try {
      releases = /** @type {ReleasesView} */ (
        await call("GET", `/admin/updates/releases${refreshFeed ? "?refresh=1" : ""}`)
      );
      const keep = versionSelect.value;
      versionSelect.replaceChildren(
        ...releases.releases
          .filter((release) => release.refusals.length === 0 && release.releaseSha256 !== null)
          .map((release) => el("option", { value: release.version }, release.version)),
      );
      const values = [...versionSelect.options].map((option) => option.value);
      versionSelect.value =
        [keep, releases.nextInstallable].find((value) => value && values.includes(value)) ??
        values[0] ??
        "";
    } catch (error) {
      releases = null;
      releaseStatus.textContent = explain(error);
    }
    render();
  }

  /** The running version the release list was loaded for (again after an update). */
  /** @type {string | null | undefined} */
  let releasesFor;
  let generation = 0; // a newer poll supersedes one still in flight

  async function poll() {
    const mine = ++generation;
    let delay = 30_000;
    try {
      const view = /** @type {AdminUpdatesView} */ (await call("GET", "/admin/updates"));
      if (stopped || mine !== generation) {
        return;
      }
      state = view.state;
      show(alert, false);
      if (state) {
        offsetMs = Date.parse(state.serverTime) - Date.now();
        fillLeadTimes(view.leadTimes);
        if (releasesFor !== state.running.version) {
          releasesFor = state.running.version;
          void loadReleases(false);
        }
        delay = state.phase === "scheduled" || state.phase === "running" ? 3000 : 30_000;
      } else {
        status.textContent = texts.noSidecar;
        show(status, true);
      }
      render();
    } catch (error) {
      if (stopped || mine !== generation) {
        return;
      }
      const code = /** @type {{ status?: number }} */ (error).status;
      alert.textContent = explain(error);
      show(alert, true);
      if (code === 401 || code === 403) {
        return; // no permission: stop polling
      }
      delay = 3000; // the app is probably being replaced
    }
    if (!stopped) {
      pollTimer = setTimeout(poll, delay);
    }
  }

  /** @param {string} path @param {unknown} body @param {string} done */
  async function act(path, body, done) {
    busy = true;
    render();
    show(alert, false);
    try {
      state = /** @type {StateView} */ (await call("POST", path, body));
      live.textContent = done;
      clearTimeout(pollTimer);
      void poll(); // follow the run at the faster pace at once
    } catch (error) {
      if (/** @type {{ body?: { code?: string } }} */ (error).body?.code === "step_up_required") {
        options.onStepUp?.();
      }
      alert.textContent = `${texts.requestFailed} ${explain(error)}`;
      show(alert, true);
    } finally {
      busy = false;
      render();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const release = releases?.releases.find((r) => r.version === versionSelect.value);
    if (release?.releaseSha256) {
      void act(
        "/admin/updates",
        {
          version: release.version,
          leadSeconds: Number(leadSelect.value),
          releaseSha256: release.releaseSha256,
        },
        interpolate(texts.scheduled, { version: release.version }),
      );
    }
  });
  versionSelect.addEventListener("change", render);
  cancel.addEventListener("click", () => {
    if (state?.run) {
      void act(`/admin/updates/${encodeURIComponent(state.run.id)}/cancel`, {}, texts.cancelled);
    }
  });
  acknowledge.addEventListener("click", () => {
    if (state?.run) {
      void act(
        `/admin/updates/${encodeURIComponent(state.run.id)}/acknowledge`,
        {},
        texts.acknowledged,
      );
    }
  });
  refresh.addEventListener("click", () => {
    void loadReleases(true);
  });

  const tick = setInterval(() => {
    if (state?.phase === "scheduled") {
      render();
    }
  }, 1000);
  void poll();
  return () => {
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(tick);
  };
}
