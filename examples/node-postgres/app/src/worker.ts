import { pool } from "./db.ts";

/**
 * The background worker: it writes, so the updater stops it before the backup
 * (stopBeforeUpdate, the default) and starts it after the api is healthy
 * (startOrder 2). Here it only counts notes every 30 seconds.
 */
let stopping = false;

async function tick(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM notes");
  await pool.query("INSERT INTO worker_runs (notes) VALUES ($1)", [Number(rows[0]?.count ?? 0)]);
}

async function loop(): Promise<void> {
  while (!stopping) {
    await tick().catch((error: unknown) => console.error(`worker: ${(error as Error).message}`));
    await new Promise((resolve) => setTimeout(resolve, 30_000).unref());
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    void pool.end().finally(() => process.exit(0));
  });
}

console.log("notes worker started");
void loop();
