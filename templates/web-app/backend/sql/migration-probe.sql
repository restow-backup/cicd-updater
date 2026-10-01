-- cicd-updater: migration probe queries (docs/hooks.md, "Migration probe").
--
-- The probe reads one value that changes when your schema changes. The sidecar reads it
-- before the backup (the baseline) and again after a failed update, with the new version
-- stopped. Only when both values are equal does it start the previous version again
-- (rolled_back); otherwise the run ends in needs_attention. A probe never decides alone
-- that an update succeeded.
--
-- In updater.yaml, name the preset of your migration tool. These are the exact queries
-- the sidecar runs for each preset (packages/sidecar/src/hooks.ts, PRESET_QUERIES):
--
--   hooks:
--     migrationProbe:
--       type: postgres          # or mysql (MySQL and MariaDB)
--       service: db
--       preset: prisma          # one of the presets below
--       fingerprint: true       # the default: also a hash of the column catalog
--
-- Check by hand that the query works on your database and returns ONE value:
--
--   docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -c "<query>"
--   docker compose exec db mariadb -u root -p -N -B -e "<query>" "$MYSQL_DATABASE"
--
-- If you renamed the migration table, or your tool is not listed, write the query
-- yourself (exclusive with preset): one SELECT returning one value, no ";" inside.
--
--   migrationProbe:
--     type: postgres
--     service: db
--     query: SELECT count(*) FROM my_schema_history

-- ===========================================================================
-- PostgreSQL (type: postgres)
-- ===========================================================================

-- preset: drizzle
SELECT count(*) FROM drizzle.__drizzle_migrations;
-- preset: prisma
SELECT count(*) FROM _prisma_migrations;
-- preset: knex
SELECT count(*) FROM knex_migrations;
-- preset: alembic
SELECT coalesce(string_agg(version_num, ',' ORDER BY version_num), '') FROM alembic_version;
-- preset: django
SELECT count(*) FROM django_migrations;
-- preset: flyway
SELECT count(*) FROM flyway_schema_history;
-- preset: rails
SELECT count(*) FROM schema_migrations;
-- preset: golang-migrate
SELECT version::text || ':' || dirty::text FROM schema_migrations;
-- preset: node-pg-migrate
SELECT count(*) FROM pgmigrations;
-- preset: typeorm
SELECT count(*) FROM migrations;
-- preset: sequelize
SELECT count(*) FROM "SequelizeMeta";

-- ===========================================================================
-- MySQL and MariaDB (type: mysql)
-- ===========================================================================

-- preset: drizzle
SELECT count(*) FROM __drizzle_migrations;
-- preset: prisma
SELECT count(*) FROM _prisma_migrations;
-- preset: knex
SELECT count(*) FROM knex_migrations;
-- preset: alembic
SELECT coalesce(group_concat(version_num ORDER BY version_num), '') FROM alembic_version;
-- preset: django
SELECT count(*) FROM django_migrations;
-- preset: flyway
SELECT count(*) FROM flyway_schema_history;
-- preset: rails
SELECT count(*) FROM schema_migrations;
-- preset: golang-migrate
SELECT concat(version, ':', dirty) FROM schema_migrations;
-- preset: node-pg-migrate: PostgreSQL only (a configuration error with type: mysql)
-- preset: typeorm
SELECT count(*) FROM migrations;
-- preset: sequelize
SELECT count(*) FROM `SequelizeMeta`;

-- ===========================================================================
-- The fingerprint (fingerprint: true)
-- ===========================================================================
-- The sidecar appends "#<md5 of the column catalog>" to the value, so DDL that a failed
-- migration left behind without recording itself is seen too: added, removed or renamed
-- tables and columns, changed types, nullability and defaults. It does not see indexes,
-- constraints, triggers, functions, data-only changes, or (on PostgreSQL) a changed
-- varchar length. A probe is exactly as good as its query; when in doubt the run ends in
-- needs_attention, never in a guess.
--
-- No database, or a database without a schema the app owns (a cache, a static site):
-- use `rollback.policy: always` instead of a probe. With `rollback.policy: never` every
-- failure after the point of no return ends in needs_attention.
