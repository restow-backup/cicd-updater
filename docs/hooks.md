# Hooks

Hooks are the commands and checks the sidecar runs around an update: the **backup**, the
**migration probe**, an optional separate **migration**, the **health** check and the
**smoke** checks. This page says exactly what each one runs. The keys are in the
[configuration reference](configuration.md#key-reference); where each hook sits in a run is
in the [state machine](state-machine.md).

## Principles

- Hooks come only from `updater.yaml`, which only the host operator writes. No API request
  can name a command, an image, a service or a query.
- Hooks are read-only checks, except the backup (which writes a backup file) and the
  optional migration step.
- Every command is an argument vector for the `docker` binary. No shell string is ever built
  from data. Where a shell is unavoidable (database commands that read the container's own
  environment), the script text is a constant and all data is passed as positional
  parameters (`sh -c '<constant script>' sh <arg1> <arg2> ...`). User, database and tool names
  are checked against strict patterns first.
- Commands in app containers run with `docker compose exec -T <service> <argv>`, so they use
  that container's environment and network.
- No secret is ever placed in a command-line argument or in the environment of a process
  the sidecar starts. The database password stays in the database container: the built-in
  scripts read `POSTGRES_*`, `MYSQL_*` or `MARIADB_*` there. A `command` backup receives the
  values of `envKeys` through a `0600` env file that is deleted afterwards.
- Killing a `docker compose exec` client does not stop the process inside the container.
  Database commands are therefore wrapped with `timeout` inside the container when the
  container has it: `sh -c 't="$1"; shift; exec timeout -s TERM "$t" "$@"' sh <seconds> <argv...>`.
- All output that reaches a log line or a failure detail passes the redactor.

## Backup

The backup runs in the `backup` step, before the new version can change any data.

| `hooks.backup.type` | What is backed up | File extension | Interruptible by an abort |
| --- | --- | --- | --- |
| `postgres` | one database, `pg_dump -Fc` inside the database container | `.pgdump` | yes |
| `mysql` | one database, `mysqldump` or `mariadb-dump` inside the database container, gzip-compressed by the sidecar | `.sql.gz` | no, the abort takes effect when the step ends |
| `volume` | 1 to 16 Compose volumes as one `tar.gz` | `.tar.gz` | no, the abort takes effect when the step ends |
| `command` | the output file of a container you define | `.bin` | no, the abort takes effect when the step ends |
| `none` | nothing | | |

Every backup goes through the same stages:

1. **Space check.** The sidecar estimates the size: PostgreSQL
   `SELECT pg_database_size(current_database())`, MySQL the sum of `data_length + index_length`
   of the database's tables, volumes from `docker system df -v`. The estimate times 1.25 plus
   `docker.minFreeMb` must fit into the free space of the file system the backup is written
   to, `/state/backups` (the state volume, or a separate volume mounted there;
   `backup.insufficient_space`). If no estimate can be made, only `docker.minFreeMb` is
   checked.
2. **Create** the file as `<name>.partial` in `/state/backups/`, counting bytes and computing
   the SHA-256 while writing (`backup.failed`, `backup.timeout` after
   `hooks.backup.timeoutSeconds`).
3. **Verify** it (`backup.verify_failed`, limit `verifyTimeoutSeconds`). An empty file never
   passes.
4. **Rename** it to its final name.
5. **Encrypt** it with `age` when `encryption.ageRecipients` is set, then remove the
   plaintext.
6. **Write the metadata** `<name>.json` and apply the retention.

A failed or aborted backup is deleted, including its `.partial` file: an unverified file
never looks like a backup. Names, metadata, retention and restores are described in
[backups and recovery](backups-and-recovery.md).

### `postgres`

```yaml
hooks:
  backup:
    type: postgres
    service: db             # the Compose service of the database
    user: null              # null: POSTGRES_USER of the container (fallback: postgres)
    database: null          # null: POSTGRES_DB of the container (fallback: the user name)
    lockWaitSeconds: 120
```

What runs inside the database container (with the `timeout` wrapper around it when the
container has `timeout`):

```sh
# args: user or "", database or "", lock wait seconds, application name
u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"
PGAPPNAME="$4" exec pg_dump -U "$u" -d "$d" -Fc --lock-wait-timeout="${3}s"
```

- The application name is `cicd-updater-backup-<runId>`. On a timeout, a failure or an abort
  the sidecar terminates exactly the backends with that application name
  (`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ...`), so
  no orphaned dump keeps holding locks that a migration would wait behind.
- `--lock-wait-timeout` makes the dump fail instead of waiting forever for a table lock.
- The dump authenticates as the container's own environment allows (typically the local
  socket inside the official image). No password passes through the sidecar.
- **Verification:** the file starts with `PGDMP` (custom format), and `pg_restore --list`,
  run inside the database container with the file streamed to its standard input, lists at
  least one entry.

### `mysql` (MySQL and MariaDB)

```yaml
hooks:
  backup:
    type: mysql
    service: db
    user: null              # null: root with MYSQL_ROOT_PASSWORD or MARIADB_ROOT_PASSWORD
    database: null          # null: MYSQL_DATABASE or MARIADB_DATABASE
    flavor: auto            # auto | mysql | mariadb
```

What runs inside the database container:

```sh
# args: user or "", database or "", lock wait seconds (unused), tool or "auto"
if [ -n "$1" ]; then u="$1"; p="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}";
else u=root; p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; fi
d="${2:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"
t="$4"; if [ "$t" = auto ]; then if command -v mariadb-dump >/dev/null 2>&1; then t=mariadb-dump; else t=mysqldump; fi; fi
MYSQL_PWD="$p" exec "$t" -u "$u" --single-transaction --routines --triggers --events "$d"
```

- `flavor: mysql` forces `mysqldump`, `mariadb` forces `mariadb-dump`, `auto` uses
  `mariadb-dump` when the container has it.
- With a configured `user`, the password comes from `MYSQL_PASSWORD` or `MARIADB_PASSWORD`
  of the container. `MYSQL_PWD` is set only inside the database container's shell, from that
  container's own environment.
- `--single-transaction` gives a consistent dump of InnoDB tables without table locks;
  `lockWaitSeconds` has no MySQL equivalent and is not used.
- The sidecar compresses the output with gzip while writing.
- **Verification:** the file decompresses completely, and its last non-empty line starts
  with `-- Dump completed`.

### `volume`

```yaml
hooks:
  backup:
    type: volume
    volumes: [uploads, sqlite-data]   # Compose volume names, as in the Compose file
```

- The names are the keys of the Compose file's `volumes:` section. The sidecar resolves the
  real volume name from `docker compose config` (or `<project>_<name>`).
- `quiesce` is always `true` for volume backups: the `stop` step runs before the backup, so
  the files are not changing while they are copied. The point of no return is therefore
  reached before the backup starts.
- What runs: a one-off container of the sidecar's own image,

  ```
  docker run --rm --label io.github.restow-backup.cicd-updater.managed=true \
    --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --volume <project>_uploads:/backup-src/uploads:ro \
    --volume <project>_sqlite-data:/backup-src/sqlite-data:ro \
    --entrypoint tar <own image> -czf - -C /backup-src .
  ```

  The archive contains one top-level directory per volume (`./uploads/...`,
  `./sqlite-data/...`).
- **Verification:** `tar -tzf` in the sidecar lists entries for every configured volume.

Use it for SQLite and other file-based data. For a database server, a dump is better than a
copy of its data directory.

### `command`

For anything else (MongoDB, Redis, an external tool) you provide a container that writes one
file:

```yaml
hooks:
  backup:
    type: command
    command:
      image: docker.io/library/mongo:8@sha256:<digest>   # pinned by digest
      argv: ["mongodump", "--uri=mongodb://mongo:27017/notes", "--archive=/backup/backup.out", "--gzip"]
      envKeys: []           # env file keys whose values the container receives
      network: internal     # project | none | a network key of the Compose file
      outputFile: backup.out
```

What happens:

1. A temporary volume `cicd-updater-backup-<runId>` is created.
2. The image runs once:

   ```
   docker run --rm --label io.github.restow-backup.cicd-updater.managed=true \
     --network <network> --volume cicd-updater-backup-<runId>:/backup \
     --env-file /state/tmp/backup-<runId>.env <image> <argv...>
   ```

   The env file holds `KEY=value` for every key in `envKeys` that has a value in the
   project's env file (values with line breaks are skipped). It has mode `0600` and is deleted
   afterwards. The values are registered with the redactor.
3. A second one-off container of the sidecar's own image (read-only, no network) copies
   `/backup/<outputFile>` out of the volume to the sidecar.
4. The temporary volume is removed.

`network` decides where the backup container is attached:

| Value | Network |
| --- | --- |
| `project` (default) | the project's default network: the network Compose calls `default`, usually `<project>_default` |
| a network key of the Compose file, for example `internal` | that network, resolved to its Compose name (`<project>_internal`, or the `name:` the file gives it) |
| `none` | no network at all |

Choose the network the database is on. When your services use only their own networks (as
in the examples, `internal` and `public`), the `default` network may not reach the database;
name the network key instead.

**Verification:** the output file exists and is not empty. The sidecar cannot know more about
a custom format; check your tool's own verification options and use them in `argv` if it has
any.

### `none`

No backup is made. With `rollback.policy: probe` the `backup` step still runs, but only to
read the probe baseline (see below). Without a probe the step is skipped. A configured probe
without a backup gives the warning `backup_none_with_probe`.

### Encryption

```yaml
hooks:
  backup:
    encryption:
      ageRecipients: [age1...]   # one or more public keys from age-keygen
```

After the backup verified, the sidecar runs `age -r <recipient> ... -o <file>.age.partial
<file>` with every recipient, renames the result to `<file>.age` (mode `0600`) and removes the
plaintext. The metadata then records the size and SHA-256 of the encrypted file. The private
key (the age identity) never needs to be on the host. Key handling and decryption are in
[backups and recovery](backups-and-recovery.md#encryption).

### Retention

`retention.keep` (default 3) newest backups are kept; backups older than
`retention.maxAgeDays` (default 14, 0 = no age limit) are deleted. The backup of the newest
run that ended in `needs_attention` is never deleted. Details:
[backups and recovery](backups-and-recovery.md#retention).

## Migration probe

The migration probe reads one value that changes when the app's schema changes. It is what
makes a rollback after the point of no return safe: the sidecar starts the old version again
only when the value after the failed update equals the value before it (see
[the rollback rule](state-machine.md#the-rollback-rule)).

When it runs:

| Moment | Why |
| --- | --- |
| in the `backup` step, immediately before the backup is created (in both step orders) | the **baseline**; `backup.baseline_unavailable` when it fails |
| after a failure past the point of no return, once the new version is stopped ("freeze") | the value to compare with the baseline |

The probe runs only with `rollback.policy: probe`, which is the default when a probe is
configured.

### The probe value

The output (stdout of the query or command, or the JSON value of the HTTP probe) is trimmed,
runs of white space are collapsed to one space, and the result must be at most 1024
printable ASCII characters. Two values are compared for exact equality. A non-zero exit, a
timeout (`timeoutSeconds`, default 60, per query), a longer or non-printable value is a
**probe failure**: the state is unknown, and the run cannot roll back.

### Types

| `migrationProbe.type` | What runs |
| --- | --- |
| `postgres` | a preset or your `query` through `psql` in the database container |
| `mysql` | a preset or your `query` through `mariadb` (or `mysql`) in the database container |
| `command` | `docker compose exec -T <command.service> <command.argv>`; stdout is the value |
| `http` | `GET <http.url>` with `Authorization: Bearer <token>`; the value at `http.jsonPath` is the value |
| `none` | no probe; `rollback.policy: probe` is not allowed |

The database queries run through constant scripts:

```sh
# PostgreSQL (args: user or "", database or "", sql)
u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"
exec psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$u" -d "$d" -c "$3"

# MySQL / MariaDB (args: user or "", database or "", sql)
if [ -n "$1" ]; then u="$1"; p="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}";
else u=root; p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; fi
d="${2:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"
c=mysql; command -v mariadb >/dev/null 2>&1 && c=mariadb
MYSQL_PWD="$p" exec "$c" -N -B -u "$u" -e "$3" "$d"
```

A custom `query` must be one `SELECT` that returns one value. `preset` and `query` are
exclusive.

### Presets

| Preset | PostgreSQL | MySQL / MariaDB |
| --- | --- | --- |
| `drizzle` | `SELECT count(*) FROM drizzle.__drizzle_migrations` | `SELECT count(*) FROM __drizzle_migrations` |
| `prisma` | `SELECT count(*) FROM _prisma_migrations` | same |
| `knex` | `SELECT count(*) FROM knex_migrations` | same |
| `alembic` | `SELECT coalesce(string_agg(version_num, ',' ORDER BY version_num), '') FROM alembic_version` | `SELECT coalesce(group_concat(version_num ORDER BY version_num), '') FROM alembic_version` |
| `django` | `SELECT count(*) FROM django_migrations` | same |
| `flyway` | `SELECT count(*) FROM flyway_schema_history` | same |
| `rails` | `SELECT count(*) FROM schema_migrations` | same |
| `golang-migrate` | `SELECT version::text \|\| ':' \|\| dirty::text FROM schema_migrations` | `SELECT concat(version, ':', dirty) FROM schema_migrations` |
| `node-pg-migrate` | `SELECT count(*) FROM pgmigrations` | none (PostgreSQL only; a configuration error with `mysql`) |
| `typeorm` | `SELECT count(*) FROM migrations` | same |
| `sequelize` | `SELECT count(*) FROM "SequelizeMeta"` | ``SELECT count(*) FROM `SequelizeMeta` `` |

The table names are the defaults of each tool. If you renamed the migration table, write the
query yourself.

The table must exist before the first update: the baseline is read before anything new
runs, and a missing table fails the run with `backup.baseline_unavailable` (nothing is
changed). Apps that migrate at container start have it after their first start. With
`hooks.migrate`, run the migrations once when you install the app (for example
`docker compose run --rm api npm run migrate`).

### The fingerprint

With `fingerprint: true` (the default for `postgres` and `mysql`) the value becomes
`<preset or query value>#<fingerprint>`. The fingerprint is the MD5 of the ordered list of
`schema.table.column:type:nullable:default` from `information_schema.columns`:

```sql
-- PostgreSQL: every schema except pg_catalog and information_schema
SELECT md5(coalesce(string_agg(table_schema || '.' || table_name || '.' || column_name || ':' ||
  data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), ','
  ORDER BY table_schema, table_name, column_name), ''))
FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema')

-- MySQL / MariaDB: the current database
SET SESSION group_concat_max_len = 4294967295;
SELECT md5(coalesce(group_concat(concat(table_schema, '.', table_name, '.', column_name, ':',
  column_type, ':', is_nullable, ':', coalesce(column_default, '')) ORDER BY table_schema,
  table_name, column_name SEPARATOR ','), ''))
FROM information_schema.columns WHERE table_schema = DATABASE()
```

What it sees: added, removed and renamed columns and tables (including views, which have
columns too), changed column types, nullability and defaults. That catches DDL a failed
migration left behind without recording itself in the migration table. This matters most for
MySQL and MariaDB, whose DDL is not transactional.

What it does not see:

- indexes, constraints, triggers, functions, sequences, row-level security policies;
- changes of data only (an `UPDATE` in a migration);
- on PostgreSQL, a change of length or precision (`data_type` is `character varying` for any
  `varchar(n)`); MySQL's `column_type` includes it;
- columns the probe's database user cannot see.

A probe is exactly as good as its query. With PostgreSQL's transactional DDL and a migration
tool that writes its bookkeeping row in the same transaction as the migration, the count
presets are exact. When in doubt, the run ends in `needs_attention`, never in a guess.

## Separate migrations (`hooks.migrate`)

Many apps migrate their database when the container starts. If yours has a separate
migration command, the sidecar can run it as its own step, before any service starts with
the new image:

```yaml
hooks:
  migrate:
    service: api                       # a managed service; its NEW image runs the command
    argv: ["npm", "run", "migrate"]
    timeoutSeconds: 1800
```

What runs, in the `migrate` step after `stop`:

```
docker compose run --rm --no-deps -T --name cicd-updater-migrate-<runId> api npm run migrate
```

- The writable keys are set to the new references in the process environment of this
  Compose call only. The env file is not written yet, so a failed migration leaves it
  untouched.
- Before the command starts, the run records that it may have applied something
  (`applyAttempted`); from then on the [rollback rule](state-machine.md#the-rollback-rule)
  decides how a failure ends.
- A non-zero exit fails the step with `migrate.failed` (the detail carries the redacted tail
  of the output). After `timeoutSeconds` the container is removed and the step fails with
  `migrate.timeout`.
- A leftover `cicd-updater-migrate-*` container (after a crash) is removed when the sidecar
  starts.

Migrations should be idempotent either way: a migration that ran half-way must be safe to
run again.

## Health

The `health` step decides whether the new version works. It always waits for the containers;
the app check (`hooks.health.type`) adds a check of the app itself and of its version.

### Groups and container states

Managed services are started in groups by `startOrder`, ascending. The `start` step writes
the env file and starts the lowest group; the `health` step then, for each group:

1. starts the group (from the second group on; a failing `compose up` is `start.failed` in
   step `health`);
2. waits until every service of the group is `running` within `health.timeoutSeconds`
   (`health.timeout`), and Docker-healthy as `waitForDockerHealth` says;
3. if the group is `health.afterGroup` (default: the lowest group), waits for the app check
   to be healthy and to report the target version.

After the last group it runs the app check once more, waits until every managed service is
`running` within `servicesGraceSeconds` (`health.unhealthy` otherwise) and runs every
per-service check (`services[].health`; a failure is `health.unhealthy`).

| `waitForDockerHealth` | Behavior |
| --- | --- |
| `auto` (default) | wait for `healthy` where the service has a Docker healthcheck |
| `always` | every service must have a healthcheck; a running service without one fails (`health.unhealthy`) |
| `never` | `running` is enough |

A service reported `unhealthy` by Docker when the time is up fails with `health.unhealthy`.

**Crash detection:** a managed container observed `restarting`, `exited` or `dead`
`crashLimit` times (default 2, counted per poll) fails the step at once with
`health.crashed`. The detail carries the exit code and the last 40 log lines of the service,
redacted. Polls happen every `intervalSeconds` (default 2).

### The app check

```yaml
hooks:
  health:
    type: http
    http:
      url: http://api:3000/healthz
      sendToken: true                  # Authorization: Bearer <token>
      expectStatus: [200]
      versionJsonPath: $.version       # null: no version check
      conditions:
        - { path: $.database, equals: ok }
      requestTimeoutSeconds: 5
```

An HTTP check is healthy when:

- the status is in `expectStatus` (redirects are not followed; a redirect answer counts with
  its own status),
- and every condition holds (strict equality with `equals`; with conditions or a
  `versionJsonPath`, a body that is not JSON is unhealthy).

With `versionJsonPath` the value at that path is the reported version. The body is read up to
1 MiB. With `sendToken: true` the sidecar sends the shared token, so
the app can reveal its version to the sidecar only (see [app integration](app-integration.md)).
A static file such as `version.json` can be read with `sendToken: false`.

```yaml
hooks:
  health:
    type: command
    command:
      service: api
      argv: ["/app/bin/healthcheck"]
      versionFromStdout: true          # the first line of stdout is the version
```

A command check runs `docker compose exec -T <service> <argv>` (30 seconds per call) and is
healthy on exit code 0.

**Version check:** the reported version must equal the target version (SemVer equality: a
`v` prefix and build metadata are ignored). A healthy answer with another version, or without
a version, counts as a mismatch; `versionMismatchLimit` (default 3) consecutive mismatches fail the step with
`health.version_mismatch`. An unhealthy answer resets the count. If the app never becomes
healthy within `timeoutSeconds`, the step fails with `health.timeout`; the detail carries the
last reason and the service's log tail. While it waits, the crash detection watches the
group's containers too.

`type: none` checks only the containers and gives the warning `health_without_app_check`.

### The running version

The sidecar needs the running version to refuse downgrades and to check minimum versions. It
takes the first source that yields a valid version:

1. `health`: the app check reports a version (`versionJsonPath` or `versionFromStdout`);
2. `label`: the `org.opencontainers.image.version` label of the image of the first managed
   service in the lowest group (set by the release actions);
3. `state`: the target of the last succeeded run, if the running containers still use the
   images that run installed;
4. `env`: the value of `env.versionVar` (lowest trust: it can outlive a failed update).

`GET /v1/state` and `cicd-updater status` show the version and its source. If none yields a
version, the release is refused with `running_version_unknown`.

## Smoke checks

Smoke checks run after the app is healthy, as a last end-to-end test (for example through the
edge):

```yaml
hooks:
  smoke:
    checks:
      - { type: http, url: http://web:8080/, expectStatus: [200], bodyContains: Notes }
      - { type: http, url: http://web:8080/api/ping, expectStatus: [200], sendToken: false }
      - { type: command, service: worker, argv: ["node", "scripts/selfcheck.js"], expectExitCode: 0 }
    retries: 5
    intervalSeconds: 3
    timeoutSeconds: 300
```

- `http`: a GET (30 seconds per request, redirects not followed); passes when the status is in
  `expectStatus` and, with `bodyContains`, the body (first 1 MiB) contains the text.
  `sendToken` defaults to `false` here.
- `command`: `docker compose exec -T <service> <argv>` (60 seconds per attempt); passes on
  `expectExitCode`.
- The checks run in order. Each gets up to `retries` attempts, `intervalSeconds` apart. The
  first check that does not pass fails the step with `smoke.failed` (the detail names the
  check's number and the last status, exit code or excerpt). `timeoutSeconds` limits the
  whole step: once it is over, a failing check is not retried.
- Without checks the `smoke` step is skipped.

Per-service checks (`services[].health`) have the same shape and run once, at the end of the
`health` step.
