import type { JournalEvent } from "@cicd-updater/protocol";
import type { UpdaterClient } from "./client.js";

/**
 * Exactly-once journal ingestion (design 6.4). The app stores the id of the
 * last event it wrote (the cursor) and, in ONE transaction per event, writes
 * the event into its audit log and advances the cursor. Event ids sort
 * chronologically and are unique across sidecar restarts, so ingestion can
 * resume after the app's own restart in the middle of an update.
 */
export async function syncJournal(options: {
  client: UpdaterClient;
  loadCursor(): Promise<string | null>;
  /** Write the event to the audit log AND store event.id as the cursor, in one transaction. */
  ingest(event: JournalEvent): Promise<void>;
  /** Events older than the sidecar keeps were lost (state.eventLimit). */
  onGap?(info: { after: string | null }): Promise<void>;
  /** Events per request (1 to 500, default 100). */
  batchSize?: number;
}): Promise<{ ingested: number; gap: boolean }> {
  const batch = Math.max(1, Math.min(500, options.batchSize ?? 100));
  let ingested = 0;
  let gap = false;
  for (let round = 0; round < 1000; round++) {
    const after = await options.loadCursor();
    const view = await options.client.events(after, batch);
    if (view.gap && !gap) {
      gap = true;
      await options.onGap?.({ after });
    }
    for (const event of view.events) {
      if (after !== null && event.id <= after) {
        continue;
      }
      await options.ingest(event);
      ingested += 1;
    }
    if (view.events.length < batch) {
      break;
    }
  }
  return { ingested, gap };
}
