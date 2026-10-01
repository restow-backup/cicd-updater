import type {
  BlockerCode,
  FailureCode,
  FeedErrorCode,
  MessageCode,
  Outcome,
  Phase,
  ProblemCode,
  RefusalCode,
  StepId,
  WarningCode,
} from "./codes.js";

/**
 * Catalogs that turn codes into text, in English and German. Message templates
 * use `{param}` placeholders. Every lookup has a generic fallback, because a
 * newer sidecar may send codes this catalog does not know (design 6.6).
 */

export interface Messages {
  locale: string;
  phases: Record<Phase, string>;
  outcomes: Record<Outcome, string>;
  steps: Record<StepId, string>;
  messages: Record<MessageCode, string>;
  /**
   * Texts for messages whose `version` parameter was withheld (the public status
   * without publicStatus.showVersions). Optional in custom catalogs.
   */
  messagesWithoutVersion?: Partial<Record<MessageCode, string>>;
  failures: Record<FailureCode, string>;
  blockers: Record<BlockerCode, string>;
  warnings: Record<WarningCode, string>;
  refusals: Record<RefusalCode, string>;
  problems: Record<ProblemCode, string>;
  feedErrors: Record<FeedErrorCode, string>;
  ui: {
    unknownCode: string;
    updateScheduled: string;
    updateRunning: string;
    updateSucceeded: string;
    updateFailed: string;
    startsIn: string;
    startingNow: string;
    progress: string;
    trustModeNone: string;
    maintenanceTitle: string;
    maintenanceBody: string;
    reloadHint: string;
  };
}

export const en: Messages = {
  locale: "en",
  phases: {
    idle: "No update planned",
    scheduled: "Update scheduled",
    running: "Update in progress",
    succeeded: "Update finished",
    failed: "Update failed",
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
  messages: {
    "run.scheduled": "An update to version {version} is scheduled for {startsAt}.",
    "run.rescheduled": "The update to version {version} was moved to {startsAt}.",
    "run.starting": "The update to version {version} is starting.",
    "run.succeeded": "Version {version} is now running.",
    "run.unchanged": "The update failed ({code}); nothing was changed.",
    "run.rolled_back": "The update failed ({code}); the previous version is running again.",
    "run.needs_attention": "The update failed ({code}) and needs attention.",
    "run.interrupted": "The updater restarted while the update was running.",
    "run.aborting": "The update is being aborted.",
    "step.prepare.checking": "Checking the installation.",
    "step.prepare.verifying_compose": "Checking the Compose configuration.",
    "step.fetch.verifying_signature": "Verifying signature {index} of {total}.",
    "step.fetch.signature_not_checked": "Signatures are not checked (trust mode none).",
    "step.fetch.pulling": "Downloading image {index} of {total}.",
    "step.fetch.verifying_digests": "Verifying the downloaded images.",
    "step.fetch.downloading": "Downloading the source of version {version}.",
    "step.fetch.building": "Building image {index} of {total}.",
    "step.backup.baseline": "Reading the database schema state.",
    "step.backup.creating": "Creating the backup.",
    "step.backup.verifying": "Verifying the backup.",
    "step.backup.encrypting": "Encrypting the backup.",
    "step.stop.stopping": "Stopping services.",
    "step.migrate.running": "Running database migrations.",
    "step.start.writing_env": "Writing the new image references.",
    "step.start.starting": "Starting services (group {group}).",
    "step.health.waiting": "Waiting for services (group {group}).",
    "step.health.checking_app": "Waiting for the application to report version {version}.",
    "step.health.verifying_services": "Verifying all services.",
    "step.smoke.checking": "Running check {index} of {total}.",
    "step.finish.cleaning": "Cleaning up.",
    "rollback.freezing": "Stopping the new version.",
    "rollback.probing": "Checking whether the database schema changed.",
    "rollback.restoring_env": "Restoring the previous image references.",
    "rollback.restarting": "Starting the previous version.",
    "rollback.waiting": "Waiting for the previous version.",
    "rollback.done": "The previous version is running again.",
    "rollback.failed": "The rollback did not succeed.",
    "attention.stopping": "Stopping the application for the administrator.",
    "attention.backup_kept": "The backup was kept for a restore.",
  },
  messagesWithoutVersion: {
    "run.scheduled": "An update is scheduled for {startsAt}.",
    "run.rescheduled": "The update was moved to {startsAt}.",
    "run.starting": "The update is starting.",
    "run.succeeded": "The new version is now running.",
    "step.fetch.downloading": "Downloading the source of the new version.",
    "step.health.checking_app": "Waiting for the application to report the new version.",
  },
  failures: {
    "prepare.docker_unreachable": "Docker is not reachable.",
    "prepare.docker_too_old": "The Docker Engine is too old (API 1.43 or newer is required).",
    "prepare.compose_missing": "No Compose file was found.",
    "prepare.compose_invalid": "The Compose configuration is not valid.",
    "prepare.compose_unsupported": "A managed service does not take its image from its variable.",
    "prepare.project_mismatch": "The configured project differs from the running one.",
    "prepare.env_unwritable": "The env file cannot be written.",
    "prepare.state_unwritable": "The state volume cannot be written.",
    "prepare.disk_space": "There is not enough free disk space.",
    "prepare.updater_image_unpinned": "The updater's own image follows a variable it rewrites.",
    "prepare.multiple_updaters": "Another updater runs for this project.",
    "prepare.api_exposed": "The updater has a published port.",
    "prepare.verifier_unavailable": "The signature verifier cannot start.",
    "prepare.release_signature_invalid": "The stored release document no longer verifies.",
    "prepare.release_mismatch": "The release document differs from the one that was scheduled.",
    "prepare.running_version_unknown": "The running version cannot be determined.",
    "prepare.not_newer": "The release is not newer than the running version.",
    "prepare.below_minimum_version": "The running version is too old for this release.",
    "prepare.manual_steps_required": "This release requires manual steps.",
    "prepare.updater_too_old": "The updater is too old for this release.",
    "prepare.env_missing": "Required settings are missing in the env file.",
    "prepare.image_missing": "The release lacks an image a service needs.",
    "prepare.platform_unsupported": "The release has no image for this platform.",
    "fetch.signature_missing": "An image is not signed.",
    "fetch.signature_invalid": "An image signature is not valid for this release.",
    "fetch.verifier_failed": "The signature check could not run.",
    "fetch.registry_unauthorized": "The registry refused access.",
    "fetch.registry_unreachable": "The registry is not reachable.",
    "fetch.registry_rate_limited": "The registry rate limit was reached.",
    "fetch.image_not_found": "An image of the release does not exist.",
    "fetch.pull_failed": "Downloading an image failed.",
    "fetch.digest_mismatch": "A downloaded image does not match the release.",
    "fetch.version_label_mismatch": "An image carries another version than the release.",
    "fetch.source_not_allowed": "Building from source is not allowed for this repository.",
    "fetch.token_unavailable": "The access token is not available.",
    "fetch.download_failed": "Downloading the source failed.",
    "fetch.build_failed": "Building an image failed.",
    "backup.baseline_unavailable": "The database schema state could not be read.",
    "backup.insufficient_space": "The backup would not fit on the disk.",
    "backup.failed": "The backup failed.",
    "backup.timeout": "The backup took too long.",
    "backup.verify_failed": "The backup could not be verified.",
    "stop.failed": "Stopping services failed.",
    "migrate.failed": "The database migration failed.",
    "migrate.timeout": "The database migration took too long.",
    "start.env_changed": "The env file was changed during the update.",
    "start.env_write_failed": "The env file could not be written.",
    "start.failed": "Starting services failed.",
    "health.timeout": "The application did not become healthy in time.",
    "health.crashed": "A service keeps crashing.",
    "health.version_mismatch": "The application reports another version.",
    "health.unhealthy": "A service is unhealthy.",
    "smoke.failed": "A check after the update failed.",
    aborted: "The update was aborted.",
    interrupted: "The updater restarted during the update.",
    missed_start: "The update was not started in time.",
  },
  blockers: {
    docker_unreachable: "Docker is not reachable.",
    docker_too_old: "The Docker Engine is too old.",
    compose_missing: "No Compose file was found.",
    compose_invalid: "The Compose configuration is not valid.",
    compose_unsupported: "A managed service does not take its image from its variable.",
    project_mismatch: "The configured project differs from the running one.",
    env_unwritable: "The env file cannot be written.",
    state_unwritable: "The state volume cannot be written.",
    disk_space: "There is not enough free disk space.",
    updater_image_unpinned: "The updater's own image follows a variable it rewrites.",
    multiple_updaters: "Another updater runs for this project.",
    api_exposed: "The updater has a published port.",
    verifier_unavailable: "The signature verifier cannot start.",
  },
  warnings: {
    trust_mode_none: "Signatures are not checked (trust mode none).",
    updater_image_not_digest_pinned: "The updater image is not pinned by digest.",
    self_label_missing: "The updater container lacks its role label.",
    health_without_app_check: "No application health check is configured.",
    backup_none_with_probe: "A migration probe is configured but no backup.",
    source_mode_enabled: "Building from source is enabled.",
  },
  refusals: {
    not_newer: "Not newer than the running version.",
    below_minimum_version: "Install an intermediate release first.",
    manual_steps_required: "Requires manual steps.",
    updater_too_old: "Requires a newer updater.",
    env_missing: "Required settings are missing.",
    platform_unsupported: "No image for this platform.",
    image_missing: "An image is missing in the release.",
    running_version_unknown: "The running version is unknown.",
    no_release_document: "Not installable by the updater (no release document).",
  },
  problems: {
    unauthorized: "Not authorized.",
    not_found: "Not found.",
    unsupported_media_type: "The request must be JSON.",
    payload_too_large: "The request is too large.",
    invalid_request: "The request is not valid.",
    release_not_found: "The release was not found.",
    release_unverifiable: "The release could not be verified.",
    release_refused: "The release cannot be installed.",
    release_mismatch: "The release differs from the one that was shown.",
    source_not_allowed: "Building from source is not allowed.",
    busy: "An update is already scheduled or running.",
    blocked: "The updater cannot start an update now.",
    not_scheduled: "No update is scheduled.",
    point_of_no_return: "The update can no longer be aborted.",
    not_finished: "The update has not finished.",
    feed_unavailable: "The release feed is not available.",
    internal: "Internal error.",
  },
  feedErrors: {
    rate_limited: "The release host rate limit was reached.",
    unauthorized: "The release host refused the token.",
    forbidden: "The release host denied access.",
    not_found: "The repository was not found (or the token has no access).",
    server_error: "The release host had an error.",
    network: "The release host is not reachable.",
    timeout: "The release host did not answer in time.",
    invalid_response: "The release host sent an unexpected answer.",
    no_release: "No release was found.",
    redirect: "The release host redirected elsewhere.",
  },
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
    maintenanceTitle: "Maintenance in progress",
    maintenanceBody: "This service is being updated and will be back shortly.",
    reloadHint: "This page reloads automatically.",
  },
};

export const de: Messages = {
  locale: "de",
  phases: {
    idle: "Kein Update geplant",
    scheduled: "Update geplant",
    running: "Update läuft",
    succeeded: "Update abgeschlossen",
    failed: "Update fehlgeschlagen",
  },
  outcomes: {
    succeeded: "Die neue Version läuft.",
    unchanged: "Es wurde nichts verändert; die bisherige Version lief weiter.",
    rolled_back: "Das Update wurde zurückgenommen; die bisherige Version läuft wieder.",
    needs_attention:
      "Das Update braucht den Eingriff einer Administratorin oder eines Administrators.",
  },
  steps: {
    prepare: "Vorbereiten",
    fetch: "Herunterladen und prüfen",
    backup: "Sichern",
    stop: "Dienste anhalten",
    migrate: "Migrieren",
    start: "Neue Version starten",
    health: "Zustand prüfen",
    smoke: "Abschlussprüfungen",
    finish: "Aufräumen",
  },
  messages: {
    "run.scheduled": "Ein Update auf Version {version} ist für {startsAt} geplant.",
    "run.rescheduled": "Das Update auf Version {version} wurde auf {startsAt} verschoben.",
    "run.starting": "Das Update auf Version {version} beginnt.",
    "run.succeeded": "Version {version} läuft jetzt.",
    "run.unchanged": "Das Update ist fehlgeschlagen ({code}); es wurde nichts verändert.",
    "run.rolled_back":
      "Das Update ist fehlgeschlagen ({code}); die bisherige Version läuft wieder.",
    "run.needs_attention": "Das Update ist fehlgeschlagen ({code}) und braucht einen Eingriff.",
    "run.interrupted": "Der Updater wurde während des Updates neu gestartet.",
    "run.aborting": "Das Update wird abgebrochen.",
    "step.prepare.checking": "Die Installation wird geprüft.",
    "step.prepare.verifying_compose": "Die Compose-Konfiguration wird geprüft.",
    "step.fetch.verifying_signature": "Signatur {index} von {total} wird geprüft.",
    "step.fetch.signature_not_checked": "Signaturen werden nicht geprüft (Vertrauensmodus none).",
    "step.fetch.pulling": "Abbild {index} von {total} wird heruntergeladen.",
    "step.fetch.verifying_digests": "Die heruntergeladenen Abbilder werden geprüft.",
    "step.fetch.downloading": "Der Quelltext von Version {version} wird heruntergeladen.",
    "step.fetch.building": "Abbild {index} von {total} wird gebaut.",
    "step.backup.baseline": "Der Stand des Datenbankschemas wird gelesen.",
    "step.backup.creating": "Die Sicherung wird erstellt.",
    "step.backup.verifying": "Die Sicherung wird geprüft.",
    "step.backup.encrypting": "Die Sicherung wird verschlüsselt.",
    "step.stop.stopping": "Dienste werden angehalten.",
    "step.migrate.running": "Datenbankmigrationen laufen.",
    "step.start.writing_env": "Die neuen Abbild-Referenzen werden eingetragen.",
    "step.start.starting": "Dienste werden gestartet (Gruppe {group}).",
    "step.health.waiting": "Warten auf die Dienste (Gruppe {group}).",
    "step.health.checking_app": "Warten, bis die Anwendung Version {version} meldet.",
    "step.health.verifying_services": "Alle Dienste werden geprüft.",
    "step.smoke.checking": "Prüfung {index} von {total} läuft.",
    "step.finish.cleaning": "Es wird aufgeräumt.",
    "rollback.freezing": "Die neue Version wird angehalten.",
    "rollback.probing": "Es wird geprüft, ob sich das Datenbankschema geändert hat.",
    "rollback.restoring_env": "Die bisherigen Abbild-Referenzen werden wiederhergestellt.",
    "rollback.restarting": "Die bisherige Version wird gestartet.",
    "rollback.waiting": "Warten auf die bisherige Version.",
    "rollback.done": "Die bisherige Version läuft wieder.",
    "rollback.failed": "Das Zurücknehmen ist nicht gelungen.",
    "attention.stopping": "Die Anwendung wird für den Eingriff angehalten.",
    "attention.backup_kept": "Die Sicherung wurde für eine Wiederherstellung aufbewahrt.",
  },
  messagesWithoutVersion: {
    "run.scheduled": "Ein Update ist für {startsAt} geplant.",
    "run.rescheduled": "Das Update wurde auf {startsAt} verschoben.",
    "run.starting": "Das Update beginnt.",
    "run.succeeded": "Die neue Version läuft jetzt.",
    "step.fetch.downloading": "Der Quelltext der neuen Version wird heruntergeladen.",
    "step.health.checking_app": "Warten, bis die Anwendung die neue Version meldet.",
  },
  failures: {
    "prepare.docker_unreachable": "Docker ist nicht erreichbar.",
    "prepare.docker_too_old": "Die Docker Engine ist zu alt (API 1.43 oder neuer ist nötig).",
    "prepare.compose_missing": "Es wurde keine Compose-Datei gefunden.",
    "prepare.compose_invalid": "Die Compose-Konfiguration ist ungültig.",
    "prepare.compose_unsupported":
      "Ein verwalteter Dienst nimmt sein Abbild nicht aus seiner Variable.",
    "prepare.project_mismatch": "Das konfigurierte Projekt weicht vom laufenden ab.",
    "prepare.env_unwritable": "Die Env-Datei ist nicht beschreibbar.",
    "prepare.state_unwritable": "Das Zustands-Volume ist nicht beschreibbar.",
    "prepare.disk_space": "Es ist nicht genug Speicherplatz frei.",
    "prepare.updater_image_unpinned":
      "Das Abbild des Updaters folgt einer Variable, die er selbst umschreibt.",
    "prepare.multiple_updaters": "Für dieses Projekt läuft ein weiterer Updater.",
    "prepare.api_exposed": "Der Updater hat einen veröffentlichten Port.",
    "prepare.verifier_unavailable": "Die Signaturprüfung kann nicht starten.",
    "prepare.release_signature_invalid":
      "Das gespeicherte Release-Dokument lässt sich nicht mehr prüfen.",
    "prepare.release_mismatch": "Das Release-Dokument weicht vom geplanten ab.",
    "prepare.running_version_unknown": "Die laufende Version lässt sich nicht ermitteln.",
    "prepare.not_newer": "Das Release ist nicht neuer als die laufende Version.",
    "prepare.below_minimum_version": "Die laufende Version ist für dieses Release zu alt.",
    "prepare.manual_steps_required": "Dieses Release erfordert manuelle Schritte.",
    "prepare.updater_too_old": "Der Updater ist für dieses Release zu alt.",
    "prepare.env_missing": "In der Env-Datei fehlen nötige Einstellungen.",
    "prepare.image_missing": "Dem Release fehlt ein Abbild, das ein Dienst braucht.",
    "prepare.platform_unsupported": "Das Release enthält kein Abbild für diese Plattform.",
    "fetch.signature_missing": "Ein Abbild ist nicht signiert.",
    "fetch.signature_invalid": "Eine Abbild-Signatur ist für dieses Release nicht gültig.",
    "fetch.verifier_failed": "Die Signaturprüfung konnte nicht laufen.",
    "fetch.registry_unauthorized": "Die Registry hat den Zugriff verweigert.",
    "fetch.registry_unreachable": "Die Registry ist nicht erreichbar.",
    "fetch.registry_rate_limited": "Das Abruflimit der Registry ist erreicht.",
    "fetch.image_not_found": "Ein Abbild des Releases existiert nicht.",
    "fetch.pull_failed": "Das Herunterladen eines Abbilds ist fehlgeschlagen.",
    "fetch.digest_mismatch": "Ein heruntergeladenes Abbild passt nicht zum Release.",
    "fetch.version_label_mismatch": "Ein Abbild trägt eine andere Version als das Release.",
    "fetch.source_not_allowed": "Bauen aus dem Quelltext ist für dieses Repository nicht erlaubt.",
    "fetch.token_unavailable": "Das Zugriffs-Token ist nicht verfügbar.",
    "fetch.download_failed": "Das Herunterladen des Quelltexts ist fehlgeschlagen.",
    "fetch.build_failed": "Das Bauen eines Abbilds ist fehlgeschlagen.",
    "backup.baseline_unavailable": "Der Stand des Datenbankschemas ließ sich nicht lesen.",
    "backup.insufficient_space": "Die Sicherung passt nicht auf den Datenträger.",
    "backup.failed": "Die Sicherung ist fehlgeschlagen.",
    "backup.timeout": "Die Sicherung hat zu lange gedauert.",
    "backup.verify_failed": "Die Sicherung ließ sich nicht prüfen.",
    "stop.failed": "Das Anhalten der Dienste ist fehlgeschlagen.",
    "migrate.failed": "Die Datenbankmigration ist fehlgeschlagen.",
    "migrate.timeout": "Die Datenbankmigration hat zu lange gedauert.",
    "start.env_changed": "Die Env-Datei wurde während des Updates geändert.",
    "start.env_write_failed": "Die Env-Datei konnte nicht geschrieben werden.",
    "start.failed": "Das Starten der Dienste ist fehlgeschlagen.",
    "health.timeout": "Die Anwendung wurde nicht rechtzeitig bereit.",
    "health.crashed": "Ein Dienst stürzt wiederholt ab.",
    "health.version_mismatch": "Die Anwendung meldet eine andere Version.",
    "health.unhealthy": "Ein Dienst ist nicht gesund.",
    "smoke.failed": "Eine Prüfung nach dem Update ist fehlgeschlagen.",
    aborted: "Das Update wurde abgebrochen.",
    interrupted: "Der Updater wurde während des Updates neu gestartet.",
    missed_start: "Das Update wurde nicht rechtzeitig gestartet.",
  },
  blockers: {
    docker_unreachable: "Docker ist nicht erreichbar.",
    docker_too_old: "Die Docker Engine ist zu alt.",
    compose_missing: "Es wurde keine Compose-Datei gefunden.",
    compose_invalid: "Die Compose-Konfiguration ist ungültig.",
    compose_unsupported: "Ein verwalteter Dienst nimmt sein Abbild nicht aus seiner Variable.",
    project_mismatch: "Das konfigurierte Projekt weicht vom laufenden ab.",
    env_unwritable: "Die Env-Datei ist nicht beschreibbar.",
    state_unwritable: "Das Zustands-Volume ist nicht beschreibbar.",
    disk_space: "Es ist nicht genug Speicherplatz frei.",
    updater_image_unpinned:
      "Das Abbild des Updaters folgt einer Variable, die er selbst umschreibt.",
    multiple_updaters: "Für dieses Projekt läuft ein weiterer Updater.",
    api_exposed: "Der Updater hat einen veröffentlichten Port.",
    verifier_unavailable: "Die Signaturprüfung kann nicht starten.",
  },
  warnings: {
    trust_mode_none: "Signaturen werden nicht geprüft (Vertrauensmodus none).",
    updater_image_not_digest_pinned: "Das Updater-Abbild ist nicht per Digest festgelegt.",
    self_label_missing: "Dem Updater-Container fehlt sein Rollen-Label.",
    health_without_app_check: "Es ist keine Zustandsprüfung der Anwendung eingerichtet.",
    backup_none_with_probe: "Eine Migrationsprüfung ist eingerichtet, aber keine Sicherung.",
    source_mode_enabled: "Bauen aus dem Quelltext ist eingeschaltet.",
  },
  refusals: {
    not_newer: "Nicht neuer als die laufende Version.",
    below_minimum_version: "Zuerst ein Zwischen-Release installieren.",
    manual_steps_required: "Erfordert manuelle Schritte.",
    updater_too_old: "Erfordert einen neueren Updater.",
    env_missing: "Nötige Einstellungen fehlen.",
    platform_unsupported: "Kein Abbild für diese Plattform.",
    image_missing: "Im Release fehlt ein Abbild.",
    running_version_unknown: "Die laufende Version ist unbekannt.",
    no_release_document: "Nicht über den Updater installierbar (kein Release-Dokument).",
  },
  problems: {
    unauthorized: "Nicht berechtigt.",
    not_found: "Nicht gefunden.",
    unsupported_media_type: "Die Anfrage muss JSON sein.",
    payload_too_large: "Die Anfrage ist zu groß.",
    invalid_request: "Die Anfrage ist ungültig.",
    release_not_found: "Das Release wurde nicht gefunden.",
    release_unverifiable: "Das Release ließ sich nicht prüfen.",
    release_refused: "Das Release kann nicht installiert werden.",
    release_mismatch: "Das Release weicht vom angezeigten ab.",
    source_not_allowed: "Bauen aus dem Quelltext ist nicht erlaubt.",
    busy: "Ein Update ist bereits geplant oder läuft.",
    blocked: "Der Updater kann gerade kein Update starten.",
    not_scheduled: "Es ist kein Update geplant.",
    point_of_no_return: "Das Update lässt sich nicht mehr abbrechen.",
    not_finished: "Das Update ist noch nicht abgeschlossen.",
    feed_unavailable: "Der Release-Feed ist nicht verfügbar.",
    internal: "Interner Fehler.",
  },
  feedErrors: {
    rate_limited: "Das Abruflimit des Release-Hosts ist erreicht.",
    unauthorized: "Der Release-Host hat das Token abgelehnt.",
    forbidden: "Der Release-Host hat den Zugriff verweigert.",
    not_found: "Das Repository wurde nicht gefunden (oder das Token hat keinen Zugriff).",
    server_error: "Beim Release-Host ist ein Fehler aufgetreten.",
    network: "Der Release-Host ist nicht erreichbar.",
    timeout: "Der Release-Host hat nicht rechtzeitig geantwortet.",
    invalid_response: "Der Release-Host hat eine unerwartete Antwort geschickt.",
    no_release: "Es wurde kein Release gefunden.",
    redirect: "Der Release-Host hat woandershin umgeleitet.",
  },
  ui: {
    unknownCode: "Statuscode {code}",
    updateScheduled: "Ein Update ist geplant.",
    updateRunning: "Ein Update läuft.",
    updateSucceeded: "Das Update ist abgeschlossen.",
    updateFailed: "Das Update ist fehlgeschlagen.",
    startsIn: "Beginnt in {time}",
    startingNow: "Beginnt jetzt",
    progress: "{progress} % erledigt",
    trustModeNone: "Auf dieser Installation werden Signaturen nicht geprüft.",
    maintenanceTitle: "Wartung",
    maintenanceBody: "Dieser Dienst wird gerade aktualisiert und ist gleich wieder da.",
    reloadHint: "Diese Seite lädt sich von selbst neu.",
  },
};

export const catalogs: Readonly<Record<string, Messages>> = { en, de };

/** The catalog for a locale (`de-DE` -> `de`), English when there is none. */
export function messagesFor(locale: string | null | undefined): Messages {
  const language = (locale ?? "en").toLowerCase().split(/[-_]/)[0] ?? "en";
  return catalogs[language] ?? en;
}

/** Replace `{name}` placeholders; unknown placeholders stay as they are. */
export function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

function lookup(table: Readonly<Record<string, string>>, code: string): string | undefined {
  return Object.hasOwn(table, code) ? table[code] : undefined;
}

/** Text of a run message; unknown codes render generically. */
export function formatMessage(
  messages: Messages,
  message: { code: string; params?: Readonly<Record<string, string | number>> } | null,
): string {
  if (!message) {
    return "";
  }
  let template = lookup(messages.messages, message.code);
  if (template === undefined) {
    return interpolate(messages.ui.unknownCode, { code: message.code });
  }
  // The public status withholds the version: use the text that does not need it.
  if (template.includes("{version}") && !Object.hasOwn(message.params ?? {}, "version")) {
    template = lookup(messages.messagesWithoutVersion ?? {}, message.code) ?? template;
  }
  // A failure code inside a message is shown as its text when known.
  const params: Record<string, string | number> = { ...(message.params ?? {}) };
  return interpolate(template, params);
}

/** Text of a failure, blocker, warning, refusal, problem or feed error code, with a generic fallback. */
export function describeCode(
  messages: Messages,
  kind:
    | "failures"
    | "blockers"
    | "warnings"
    | "refusals"
    | "problems"
    | "feedErrors"
    | "steps"
    | "outcomes"
    | "phases",
  code: string,
): string {
  const table = messages[kind] as Readonly<Record<string, string>>;
  return lookup(table, code) ?? interpolate(messages.ui.unknownCode, { code });
}
