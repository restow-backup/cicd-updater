// The stub's migration: records STUB_MIGRATION in stub_migrations and adds a table, so the
// migration probe (a query plus the schema fingerprint) sees the change.
import { execFileSync } from "node:child_process";

export function migrate() {
  const migration = process.env.STUB_MIGRATION ?? "none";
  if (process.env.STUB_MIGRATE_FAIL === "1") {
    console.error(`stub: migration ${migration} fails`);
    process.exit(1);
  }
  if (migration === "none") {
    console.log("stub: no migration");
    return;
  }
  if (!/^[0-9]{1,6}$/.test(migration)) {
    throw new Error(`invalid STUB_MIGRATION ${migration}`);
  }
  const sql = [
    "CREATE TABLE IF NOT EXISTS stub_migrations (version text PRIMARY KEY)",
    `INSERT INTO stub_migrations VALUES ('${migration}') ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS stub_table_${migration} (id integer)`,
  ].join("; ");
  execFileSync(
    "psql",
    [process.env.DATABASE_URL ?? "", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      stdio: "inherit",
    },
  );
  console.log(`stub: migration ${migration} applied`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
}
