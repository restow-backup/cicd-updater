// node-pg-migrate migration. The updater's probe (preset node-pg-migrate) counts the
// rows of pgmigrations before and after the update to see whether a migration ran.

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.createTable("notes", {
    id: "id",
    title: { type: "text", notNull: true },
    body: { type: "text", notNull: true, default: "" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createTable("worker_runs", {
    id: "id",
    notes: { type: "integer", notNull: true },
    ran_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createTable("audit_log", {
    id: "id",
    source: { type: "text", notNull: true },
    event_id: { type: "text", notNull: true },
    action: { type: "text", notNull: true },
    actor: { type: "text" },
    detail: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true },
  });
  pgm.addConstraint("audit_log", "audit_log_source_event", { unique: ["source", "event_id"] });
  pgm.createTable("updater_journal_cursor", {
    id: { type: "integer", primaryKey: true },
    last_id: { type: "text", notNull: true },
  });
};

export const down = false;
