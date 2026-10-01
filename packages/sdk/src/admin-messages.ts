import { interpolate } from "@cicd-updater/protocol";

/**
 * The sentences of an admin "Updates" page (the page in templates/web-app), in
 * English and German. Codes (phases, steps, outcomes, blockers, refusals,
 * failures) stay in the `Messages` catalogs; these are the page's own texts.
 * Templates use `{param}` placeholders, filled with `interpolate`.
 */
export interface AdminMessages {
  locale: string;
  title: string;
  loading: string;
  /** The signed-in user may not manage updates (401/403). */
  forbidden: string;
  /** The app does not answer (expected while an update runs). */
  offline: string;
  /** No sidecar on this installation. */
  noSidecar: string;
  /** Link text to the app's manual update instructions. */
  manualSteps: string;
  runningVersion: string;
  unknownVersion: string;
  blocked: string;
  warnings: string;
  currentRun: string;
  /** `{from}`, `{to}`. */
  versions: string;
  /** `{label}`. */
  requestedBy: string;
  abortRequested: string;
  cancel: string;
  acknowledge: string;
  progressLabel: string;
  attentionTitle: string;
  attentionBody: string;
  attentionSchemaChanged: string;
  attentionSchemaUnchanged: string;
  attentionSchemaUnknown: string;
  /** `{file}`. */
  attentionBackup: string;
  attentionCommand: string;
  attentionCommands: string;
  attentionRunbook: string;
  attentionAcknowledge: string;
  available: string;
  checking: string;
  checkAgain: string;
  newest: string;
  nothingInstallable: string;
  version: string;
  start: string;
  notes: string;
  /** `{sha}`: the first 16 hex digits of the release.json SHA-256. */
  releaseDigest: string;
  schedule: string;
  busyRun: string;
  stepUp: string;
  /** Prefix of an error the page cannot explain better. */
  requestFailed: string;
  /** `{version}`. */
  scheduled: string;
  cancelled: string;
  acknowledged: string;
  leadTimeNow: string;
  leadTimeMinute: string;
  /** `{count}`. */
  leadTimeMinutes: string;
  leadTimeHour: string;
  /** `{count}`. */
  leadTimeHours: string;
}

export const adminEn: AdminMessages = {
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

export const adminDe: AdminMessages = {
  locale: "de",
  title: "Updates",
  loading: "Der Update-Status wird geladen …",
  forbidden:
    "Nur Administratorinnen und Administratoren der Installation können Updates verwalten.",
  offline:
    "Die App antwortet nicht. Während eines Updates ist das zu erwarten; diese Seite verbindet sich von selbst wieder.",
  noSidecar: "Updates über diese Seite sind auf dieser Installation nicht eingerichtet.",
  manualSteps: "Anleitung für das Update von Hand",
  runningVersion: "Laufende Version",
  unknownVersion: "unbekannt",
  blocked: "Updates sind gesperrt, bis diese Probleme auf dem Host behoben sind:",
  warnings: "Warnungen:",
  currentRun: "Aktuelles Update",
  versions: "Version {from} auf {to}",
  requestedBy: "Angefordert von {label}",
  abortRequested: "Abbruch angefordert; das Update hält am nächsten Prüfpunkt an.",
  cancel: "Update abbrechen",
  acknowledge: "Bestätigen",
  progressLabel: "Fortschritt",
  attentionTitle: "Dieses Update braucht einen Eingriff",
  attentionBody:
    "Das Update ist nach dem Punkt ohne Rückkehr fehlgeschlagen, und ein Zurück war nicht sicher genug. Die App wurde angehalten, die Sicherung aufbewahrt, und nichts geschieht automatisch. Wer den Host betreut, entscheidet dort, ob es zur vorherigen Version zurück oder zur neuen Version weiter geht.",
  attentionSchemaChanged:
    "Die neue Version hat das Datenbankschema geändert: Die vorherige Version darf darauf nur nach dem Zurückspielen der Sicherung laufen.",
  attentionSchemaUnchanged:
    "Das Datenbankschema ist unverändert; der Start der vorherigen Version ist fehlgeschlagen.",
  attentionSchemaUnknown:
    "Ob sich das Datenbankschema geändert hat, ist unbekannt; es ist als geändert zu behandeln.",
  attentionBackup: "Sicherung: {file}",
  attentionCommand: "Auf dem Host, im Projektverzeichnis:",
  attentionCommands:
    "Vom Updater festgehaltene Befehle zur Wiederherstellung (vor dem Ausführen prüfen)",
  attentionRunbook: "Runbook: Ein Lauf endete in needs_attention",
  attentionAcknowledge: "Erst bestätigen, wenn die Installation wieder läuft.",
  available: "Verfügbares Release",
  checking: "Releases werden gesucht …",
  checkAgain: "Nach neuen Releases suchen",
  newest: "Auf dieser Installation läuft das neueste Release.",
  nothingInstallable: "Zurzeit lässt sich kein neueres Release installieren:",
  version: "Version",
  start: "Beginn",
  notes: "Versionshinweise",
  releaseDigest: "release.json SHA-256 {sha}…",
  schedule: "Update planen",
  busyRun: "Ein Update ist bereits geplant oder läuft.",
  stepUp: "Bitte die Anmeldung bestätigen und es dann erneut versuchen.",
  requestFailed: "Die Anfrage ist fehlgeschlagen:",
  scheduled: "Das Update auf {version} ist geplant.",
  cancelled: "Das Update wurde abgebrochen oder sein Abbruch angefordert.",
  acknowledged: "Das Ergebnis wurde bestätigt.",
  leadTimeNow: "sofort",
  leadTimeMinute: "in 1 Minute",
  leadTimeMinutes: "in {count} Minuten",
  leadTimeHour: "in 1 Stunde",
  leadTimeHours: "in {count} Stunden",
};

export const adminCatalogs: Readonly<Record<string, AdminMessages>> = { en: adminEn, de: adminDe };

/** The admin texts for a locale (`de-DE` -> `de`), English when there are none. */
export function adminMessagesFor(locale: string | null | undefined): AdminMessages {
  const language = (locale ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  return adminCatalogs[language] ?? adminEn;
}

/** A lead time of the schedule form: `0` -> "now", `300` -> "in 5 minutes", `3600` -> "in 1 hour". */
export function formatLeadTime(texts: AdminMessages, seconds: number): string {
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
