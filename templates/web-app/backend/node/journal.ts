import { type JournalEvent, syncJournal, type UpdaterClient } from "@restow-backup/cicd-updater";

/**
 * cicd-updater: copy the sidecar's journal into your audit log, exactly once
 * (docs/app-integration.md, section 2). The sidecar journals every action itself
 * (scheduled, rescheduled, cancelled, abort requested, started, succeeded, failed,
 * acknowledged), with the `requestedBy` your endpoints pass. Events recorded while
 * the app was down for the update are ingested when it is back.
 *
 * TODO(cicd-updater): implement JournalStore on your database. With PostgreSQL:
 *
 *   CREATE TABLE audit_log (
 *     id bigserial PRIMARY KEY, source text NOT NULL, event_id text NOT NULL,
 *     action text NOT NULL, actor text, detail jsonb, created_at timestamptz NOT NULL,
 *     UNIQUE (source, event_id)
 *   );
 *   CREATE TABLE updater_journal_cursor (id integer PRIMARY KEY, last_id text NOT NULL);
 *
 *   loadCursor:  SELECT last_id FROM updater_journal_cursor WHERE id = 1
 *   ingest, in ONE transaction:
 *     INSERT INTO audit_log (source, event_id, action, actor, detail, created_at)
 *       VALUES ('updater', $id, $action, $actorLabel, $eventJson, $at)
 *       ON CONFLICT (source, event_id) DO NOTHING;
 *     INSERT INTO updater_journal_cursor (id, last_id) VALUES (1, $id)
 *       ON CONFLICT (id) DO UPDATE SET last_id = $id;
 *   recordGap:   INSERT INTO audit_log (...) VALUES ('updater', 'gap-<time>', 'journal_gap', ...)
 */
export interface JournalStore {
  loadCursor(): Promise<string | null>;
  /** Write the event into the audit log AND store event.id as the cursor, in one transaction. */
  ingest(event: JournalEvent): Promise<void>;
  /** Events were lost (more than state.eventLimit since the cursor, or a reset sidecar). */
  recordGap(after: string | null): Promise<void>;
}

/**
 * Polls every 30 seconds while idle and every 3 seconds while a run is scheduled or
 * running. Start it once per process; with several app instances the cursor and the
 * unique index keep the audit log free of duplicates. Returns a function that stops it.
 */
export function startJournalSync(
  updater: UpdaterClient,
  store: JournalStore,
  log: (message: string) => void = console.error,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const round = async (): Promise<number> => {
    const state = await updater.state();
    if (!state) {
      return 30_000; // no sidecar on this installation
    }
    await syncJournal({
      client: updater,
      loadCursor: () => store.loadCursor(),
      ingest: (event) => store.ingest(event),
      onGap: ({ after }) => store.recordGap(after),
    });
    return state.phase === "scheduled" || state.phase === "running" ? 3_000 : 30_000;
  };

  const loop = (): void => {
    round()
      .catch((error: unknown) => {
        log(`cicd-updater journal sync: ${(error as Error).message}`);
        return 30_000;
      })
      .then((delay) => {
        if (!stopped) {
          timer = setTimeout(loop, delay);
          timer.unref?.();
        }
      });
  };
  loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
