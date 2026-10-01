# React components

`@restow-backup/cicd-updater/react` shows every signed-in user that an update is coming, how
far it is, and how it ended. It consists of two hooks, two components and the plain logic
behind them. The components render plain elements with `data-*` hooks and impose no
styling.

```ts
import {
  useMaintenance,
  useCountdown,
  MaintenanceBanner,
  UpdateProgress,
  MaintenanceTracker,
  countdownOf,
  formatCountdown,
  type MaintenanceSnapshot,
  type MaintenanceView,
  type UseMaintenanceOptions,
  type PartProps,
} from "@restow-backup/cicd-updater/react";
```

Requirements: React 18 or newer (an optional peer dependency of the package). The entry
point runs in the browser and does not need Node.js.

## Contents

- [Data flow](#data-flow)
- [`useMaintenance`](#usemaintenance)
- [Behaviour](#behaviour)
- [`useCountdown`, `countdownOf`, `formatCountdown`](#usecountdown-countdownof-formatcountdown)
- [`MaintenanceBanner`](#maintenancebanner)
- [`UpdateProgress`](#updateprogress)
- [`MaintenanceTracker`](#maintenancetracker)
- [Styling](#styling)
- [Internationalisation](#internationalisation)
- [Complete example](#complete-example)

## Data flow

The browser never talks to the sidecar. It polls two sources:

1. **Your app's own maintenance endpoint**, readable by every signed-in user. It returns
   `maintenanceViewOf(await updater.state())` from the [SDK](sdk.md#maintenanceviewof): the
   public status plus the versions.
2. **The public status through your edge** (`/public/v1/status`), used only while your app
   does not answer, which is the case while it is being replaced. Your edge forwards this
   path to the sidecar ([maintenance page](maintenance-page.md)).

```
browser ──▶ app  GET /api/maintenance  ──▶ sidecar GET /v1/state (with token)
   │
   └──▶ edge GET /public/v1/status ──▶ sidecar (no token; only while the app is down)
```

Server side (Node.js):

```ts
import { createUpdaterClient, maintenanceViewOf } from "@restow-backup/cicd-updater";

const updater = createUpdaterClient({ url: process.env.UPDATER_URL ?? "", tokenFile: "/run/cicd-updater/token" });

// GET /api/maintenance: every signed-in user may read it
app.get("/api/maintenance", requireSignedIn, async (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json(maintenanceViewOf(await updater.state().catch(() => null)));
});
```

## `useMaintenance`

```ts
function useMaintenance(options: UseMaintenanceOptions): MaintenanceSnapshot;

interface UseMaintenanceOptions {
  fetchMaintenance: () => Promise<MaintenanceView>;           // your app's endpoint
  fetchPublicStatus?: () => Promise<PublicStatus | null>;     // the edge's public status
  idlePollMs?: number;                                        // default 30000
  activePollMs?: number;                                      // default 2000
  onReload?: () => void;                                      // default: location.reload()
}

interface MaintenanceSnapshot {
  view: MaintenanceView | null;    // what to show (the public status shape)
  apiReachable: boolean;           // your endpoint answered the last poll
  offsetMs: number;                // server time minus local time
  phase: "idle" | "scheduled" | "running" | "succeeded" | "failed";
  countdownSeconds: number | null; // seconds until a scheduled run starts
}
```

`fetchMaintenance` must **throw** when your endpoint does not answer successfully (network
error, `502`, `503`, `504`, any non-2xx status). A thrown error is what switches the hook to
`fetchPublicStatus`. `fetchPublicStatus` may return `null` or throw; both mean "nothing
known".

```ts
async function fetchMaintenance(): Promise<MaintenanceView> {
  const response = await fetch("/api/maintenance", { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as MaintenanceView;
}

async function fetchPublicStatus(): Promise<MaintenanceView | null> {
  const response = await fetch("/public/v1/status", { cache: "no-store" });
  return response.ok ? ((await response.json()) as MaintenanceView) : null;
}
```

Call the hook once, near the root of your signed-in layout, and pass the snapshot to the
components. The options are read on every poll, so new callback identities do not restart
polling. Polling starts in an effect, so server-side rendering yields the idle snapshot.

## Behaviour

| Topic | Rule |
| --- | --- |
| First poll | immediately after mount |
| Poll interval | `activePollMs` (2 s) while the phase is `scheduled` or `running`, and while your endpoint does not answer; otherwise `idlePollMs` (30 s) |
| Fallback | when `fetchMaintenance` throws, `apiReachable` becomes `false` and the view comes from `fetchPublicStatus`. Without it (or when it fails too) the view is `null` and the phase `idle` |
| Clock offset | every answer with `serverTime` adds a sample (server time minus local time at arrival). The last 8 samples are kept and the largest one is used: network delay only makes samples smaller, so the largest is the closest to the truth. Countdowns use the server's clock, not the user's |
| Reload after success | when an answer shows `succeeded` for a run that this page saw `scheduled` or `running`, the hook calls `onReload` after 2.5 seconds, so the user sees the result first. It reloads at most once per run and never twice within 60 seconds. A page opened after the update finished does not reload |
| Stale failures | a `failed` run that this page never saw scheduled or running, and that finished more than 24 hours ago (server clock), is shown as `idle`. A failure the page saw, or a recent one, is shown |
| Finished runs | a finished run stays visible until an admin acknowledges it, because the sidecar keeps it as the current run until then |
| Unmount | polling stops; a pending reload timer still fires |

While your app is down, the view comes from the public status: it has no versions unless
the operator enabled `publicStatus.showVersions`. See the
[note on placeholders](#version-placeholders).

## `useCountdown`, `countdownOf`, `formatCountdown`

```ts
function useCountdown(startsAt: string | null, offsetMs: number): number | null;
function countdownOf(startsAt: string, offsetMs: number, localNow?: number): number;
function formatCountdown(seconds: number): string;
```

- `useCountdown` re-renders every second while `startsAt` is set and returns the seconds
  until it (never negative), or `null` without a start time. `MaintenanceBanner` uses it
  internally.
- `countdownOf` computes the same value once: `(startsAt - (localNow + offsetMs)) / 1000`,
  rounded, at least 0.
- `formatCountdown(75)` is `1:15`; `formatCountdown(3725)` is `1:02:05`.

```tsx
const seconds = useCountdown(snapshot.view?.startsAt ?? null, snapshot.offsetMs);
```

## `MaintenanceBanner`

```ts
function MaintenanceBanner(props: PartProps): JSX.Element | null;

interface PartProps {
  snapshot: MaintenanceSnapshot;
  messages?: Messages;     // default: the English catalog
  className?: string;
}
```

Renders nothing while the phase is `idle` or there is no view. Otherwise:

```html
<div role="status" aria-live="polite" class="…" data-state="scheduled" data-outcome="…">
  <strong data-part="title">An update is scheduled.</strong>
  <span data-part="detail"> Starts in 4:12</span>
</div>
```

| Phase | Title | Detail |
| --- | --- | --- |
| `scheduled` | `ui.updateScheduled` | `ui.startsIn` with the ticking countdown, or `ui.startingNow` at 0 |
| `running` | `ui.updateRunning` | the run message (for example "Creating the backup.") |
| `succeeded` | `ui.updateSucceeded` | the run message ("Version 1.4.0 is now running.") |
| `failed` | `ui.updateFailed` | the outcome text (for example "The update was rolled back; the previous version is running again.") |

`data-outcome` is present when the run has an outcome (`succeeded`, `unchanged`,
`rolled_back`, `needs_attention`).

## `UpdateProgress`

```ts
function UpdateProgress(props: PartProps): JSX.Element | null;
```

Renders nothing when there is no view or the view has no steps. Otherwise a progress bar
and the step list (skipped steps are left out):

```html
<div class="…" data-state="running">
  <div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="43" data-part="bar">
    <div data-part="fill" style="width: 43%"></div>
  </div>
  <p data-part="progress">43 % done</p>
  <ol data-part="steps">
    <li data-status="done">Preparing</li>
    <li data-status="done">Downloading and verifying</li>
    <li data-status="running">Backing up</li>
    <li data-status="pending">Stopping services</li>
    …
  </ol>
</div>
```

It also renders for a finished run, which still has its steps. To show it only during an
update, render it conditionally:

```tsx
{snapshot.phase === "running" ? <UpdateProgress snapshot={snapshot} /> : null}
```

## `MaintenanceTracker`

The logic of `useMaintenance` without React, for tests or other frameworks:

```ts
class MaintenanceTracker {
  snapshot: MaintenanceSnapshot;
  /** Record an answer; `reload: true` means: reload the page in 2.5 seconds. */
  observe(view: MaintenanceView | null, localNow: number, apiReachable: boolean): { reload: boolean };
  /** The delay until the next poll. */
  nextPollMs(idlePollMs: number, activePollMs: number): number;
}
```

```ts
const tracker = new MaintenanceTracker();
async function poll() {
  let view = null;
  let reachable = true;
  try {
    view = await fetchMaintenance();
  } catch {
    reachable = false;
    view = await fetchPublicStatus().catch(() => null);
  }
  if (tracker.observe(view, Date.now(), reachable).reload) {
    setTimeout(() => location.reload(), 2500);
  }
  render(tracker.snapshot);
  setTimeout(poll, tracker.nextPollMs(30_000, 2_000));
}
```

## Styling

The components set `className` on their root element and expose their state through
attributes. Style them with any CSS approach.

| Element | Attribute | Values |
| --- | --- | --- |
| banner root, progress root | `data-state` | `scheduled`, `running`, `succeeded`, `failed` (the progress root can also be `idle`) |
| banner root | `data-outcome` | `succeeded`, `unchanged`, `rolled_back`, `needs_attention` (absent without an outcome) |
| banner | `data-part` | `title`, `detail` |
| progress | `data-part` | `bar`, `fill`, `progress`, `steps` |
| step item (`li`) | `data-status` | `pending`, `running`, `done`, `failed` |

The fill width is set inline (`style="width: 43%"`); everything else is up to you.

```css
:root {
  --update-info: #1d4ed8;
  --update-ok: #15803d;
  --update-warn: #b45309;
  --update-error: #b91c1c;
  --update-surface: #f8fafc;
  --update-track: #e2e8f0;
}

.update-banner {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-left: 4px solid var(--update-info);
  background: var(--update-surface);
}
.update-banner[data-state="succeeded"] { border-color: var(--update-ok); }
.update-banner[data-state="failed"] { border-color: var(--update-warn); }
.update-banner[data-outcome="needs_attention"] { border-color: var(--update-error); }

.update-progress [data-part="bar"] {
  height: 0.5rem;
  border-radius: 999px;
  background: var(--update-track);
  overflow: hidden;
}
.update-progress [data-part="fill"] {
  height: 100%;
  background: var(--update-info);
  transition: width 0.4s ease;
}
.update-progress [data-part="steps"] { list-style: none; padding: 0; }
.update-progress li[data-status="done"]::before { content: "✓ "; color: var(--update-ok); }
.update-progress li[data-status="running"] { font-weight: 600; }
.update-progress li[data-status="pending"] { opacity: 0.6; }
.update-progress li[data-status="failed"] { color: var(--update-error); }

@media (prefers-reduced-motion: reduce) {
  .update-progress [data-part="fill"] { transition: none; }
}
```

```tsx
<MaintenanceBanner snapshot={snapshot} className="update-banner" />
<UpdateProgress snapshot={snapshot} className="update-progress" />
```

## Internationalisation

The components take a `messages` catalog (type `Messages` from
[`/messages`](sdk.md#messages)) and default to English. The package ships `en` and `de`:

```tsx
import { messagesFor } from "@restow-backup/cicd-updater/messages";

const messages = messagesFor(navigator.language); // "de-DE" gives the German catalog, unknown languages English
<MaintenanceBanner snapshot={snapshot} messages={messages} />
```

The components use these parts of the catalog:

| Key | Used for |
| --- | --- |
| `ui.updateScheduled`, `ui.updateRunning`, `ui.updateSucceeded`, `ui.updateFailed` | banner titles |
| `ui.startsIn` (`{time}`), `ui.startingNow` | the countdown |
| `ui.progress` (`{progress}`) | the progress text |
| `ui.unknownCode` (`{code}`) | codes the catalog does not know |
| `messages` | run messages (`run.*`, `step.*`, `rollback.*`, `attention.*`) |
| `outcomes` | the detail of a failed run |
| `steps` | the step list |
| `phases` | fallback titles |

### Custom catalogs

Start from a shipped catalog and override what you need. A new language must provide
every key; TypeScript tells you which are missing.

```ts
import { en, type Messages } from "@restow-backup/cicd-updater/messages";

export const enNotes: Messages = {
  ...en,
  ui: {
    ...en.ui,
    updateScheduled: "Notes will be updated soon.",
    startsIn: "Maintenance starts in {time}",
  },
};

export const fr: Messages = {
  ...en,
  locale: "fr",
  phases: { idle: "Aucune mise à jour prévue", scheduled: "Mise à jour prévue", running: "Mise à jour en cours", succeeded: "Mise à jour terminée", failed: "Échec de la mise à jour" },
  // ... outcomes, steps, messages, failures, blockers, warnings, refusals, problems, feedErrors, ui
};
```

Templates use `{name}` placeholders. A code the catalog does not know renders as
`ui.unknownCode` (`Status code {code}`), because a newer sidecar may send new codes.

### Version placeholders

Several run messages carry the version as a parameter: `run.scheduled`, `run.rescheduled`,
`run.starting`, `run.succeeded`, `step.fetch.downloading` and `step.health.checking_app`.
Your endpoint (`maintenanceViewOf`) includes it. The public status removes it unless
`publicStatus.showVersions` is on. When a message arrives without its `version`
parameter, the formatter uses the catalog's `messagesWithoutVersion` text for that code
instead ("Waiting for the application to report the new version."), so no `{version}`
placeholder reaches the page. The `en` and `de` catalogs have these texts; a custom
catalog should provide them too, otherwise the placeholder stays in the text:

```ts
export const messages: Messages = {
  ...en,
  messagesWithoutVersion: {
    ...en.messagesWithoutVersion,
    "step.health.checking_app": "Waiting for the application to answer.",
  },
};
```

## Complete example

```tsx
import {
  MaintenanceBanner,
  type MaintenanceView,
  UpdateProgress,
  useMaintenance,
} from "@restow-backup/cicd-updater/react";
import { messagesFor } from "@restow-backup/cicd-updater/messages";

async function fetchMaintenance(): Promise<MaintenanceView> {
  const response = await fetch("/api/maintenance", { cache: "no-store" });
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as MaintenanceView;
}

async function fetchPublicStatus(): Promise<MaintenanceView | null> {
  const response = await fetch("/public/v1/status", { cache: "no-store" });
  return response.ok ? ((await response.json()) as MaintenanceView) : null;
}

const messages = messagesFor(navigator.language);

export function UpdateNotice() {
  const snapshot = useMaintenance({ fetchMaintenance, fetchPublicStatus });
  return (
    <>
      <MaintenanceBanner snapshot={snapshot} messages={messages} className="update-banner" />
      {snapshot.phase === "running" ? (
        <UpdateProgress snapshot={snapshot} messages={messages} className="update-progress" />
      ) : null}
    </>
  );
}
```

The example in `examples/node-postgres` uses the same pattern; [app integration](app-integration.md)
shows the server side.
