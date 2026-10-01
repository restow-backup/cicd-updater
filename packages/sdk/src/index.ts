/**
 * @restow-backup/cicd-updater: the app's side of cicd-updater (design 7).
 * Server-side (Node.js 22 or newer): the sidecar client and the journal sync.
 * Other entry points: /feed, /auth, /protocol, /semver, /messages, /react.
 */

export {
  type BackupInfo,
  type Capabilities,
  DEFAULT_LEAD_TIMES,
  type EventsView,
  type JournalEvent,
  type Problem,
  type PublicStatus,
  type ReleasesView,
  type Run,
  type RunSummary,
  type ScheduleRequest,
  type StateView,
  type VerificationResult,
} from "@cicd-updater/protocol";
export {
  createUpdaterClient,
  type UnavailableReason,
  type UpdaterClient,
  type UpdaterClientOptions,
  UpdaterProblemError,
  UpdaterUnavailableError,
} from "./client.js";
export { syncJournal } from "./journal.js";
export { type MaintenanceView, maintenanceViewOf } from "./maintenance-view.js";
