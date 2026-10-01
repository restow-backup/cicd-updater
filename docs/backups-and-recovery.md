# Backups and recovery

The sidecar backs up before it applies an update, keeps a bounded number of backups, can
encrypt them, and never restores a database on its own. This page covers where backups live,
retention, encryption, how to restore each backup type, the runbook for a run that ended in
`needs_attention`, and what to do when the sidecar itself is broken. What each backup type
runs is in [hooks](hooks.md#backup).

The examples use the project `notes` in `/opt/notes`, the managed services `api`, `worker`
and `web`, and the database service `db`. Run the commands in the project directory.

## Where backups live

| Item | Value |
| --- | --- |
| Directory | `/state/backups/` in the sidecar (the `updater-state` volume), mode `0700` |
| Files | mode `0600` |
| Name | `<project>-<yyyymmdd>-<hhmmss>Z-<from>-to-<to>.<ext>[.age]` |
| Extensions | `pgdump` (PostgreSQL custom format), `sql.gz` (MySQL/MariaDB), `tar.gz` (volumes), `bin` (command) |
| Metadata | `<name>.json`: `{ type, bytes, sha256, createdAt, runId, fromVersion, toVersion, verified, encrypted }` |

`<from>` and `<to>` are the versions, with characters outside `[0-9A-Za-z._-]` replaced by
`_` (`unknown` when the running version was not known). The time is UTC. Example:
`notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump`.

Only files whose names match this pattern are listed, pruned or streamed. Anything else you
put into the directory is never touched.

`bytes` and `sha256` in the metadata describe the stored file (for an encrypted backup, the
encrypted file). `verified: true` means the backup passed its type's verification before it
was renamed; an unverified file is never kept under a backup name.

List them:

```sh
docker compose exec updater cicd-updater backups list
# notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump  48213377 bytes  verified  protected
docker compose exec updater cicd-updater backups list --json   # with sha256, createdAt, runId, versions
```

`GET /v1/backups` returns the same list with a `protected` flag.

### Copying a backup off the host

`backups cat` streams a backup to standard output. Use `-T`, otherwise Docker allocates a
terminal and corrupts binary data:

```sh
docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump \
  > notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump
sha256sum notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump      # compare with the metadata
```

## Retention

Retention runs after every backup, in the `finish` step, when a run ends in
`needs_attention`, when the sidecar starts and once a day (not while a run is running).

1. The backups are sorted newest first.
2. The **protected** backup is set aside: the backup of the newest run in the history whose
   outcome is `needs_attention`. It is never deleted and does not count towards `keep`.
3. Of the others, every backup beyond the newest `retention.keep` (default 3) is deleted.
4. Every backup older than `retention.maxAgeDays` days (default 14) is deleted, whatever its
   position. `0` switches the age limit off.

Both limits apply. With the defaults, a backup older than 14 days is deleted even when it is
the only one; set `maxAgeDays: 0` to keep backups by count only. Deleting removes the file,
its metadata file and a leftover `.partial` file.

The protection stays when you acknowledge the run. It moves to the backup of the next run
that ends in `needs_attention`, and it ends when the protecting run drops out of the history
(`state.historyLimit`, default 20 runs). Copy a backup off the host if you need it longer.

Backups contain all data in plaintext unless encrypted. Keep `keep` small, and treat the
state volume like the database itself.

## Encryption

```yaml
hooks:
  backup:
    encryption:
      ageRecipients:
        - age1...   # the operator's key
        - age1...   # a second admin, or the next key during a rotation
```

1. Create a key pair **off the host**, for example on an admin workstation:

   ```sh
   age-keygen -o notes-backup.key
   # Public key: age1...
   ```

   The file `notes-backup.key` is the identity (private key). Keep it in a password manager
   or offline. `age-keygen -y notes-backup.key` prints the public key again.
2. Put the public key (`age1...`) into `encryption.ageRecipients` and restart the sidecar.
   Up to 16 recipients are allowed; each of them can decrypt.
3. Every new backup is verified as plaintext, encrypted to all recipients with `age`, and the
   plaintext is removed. Only `<name>.age` stays. The metadata says `encrypted: true`.

The sidecar never decrypts: the identity is never needed on the host. To rotate keys, add the
new recipient, wait until the old backups have aged out, then remove the old recipient. Old
backups remain readable only with the key they were encrypted to.

To decrypt a copied backup: `age -d -i notes-backup.key -o backup.pgdump backup.pgdump.age`.
To restore without writing the plaintext to any disk, stream it from the host through your
workstation and back:

```sh
ssh ops@host 'cd /opt/notes && docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump.age' \
  | age -d -i notes-backup.key \
  | ssh ops@host 'cd /opt/notes && docker compose exec -T db sh -c '\''pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'\'''
```

The recovery commands the sidecar renders for an encrypted backup contain
`| age -d -i <path-to-your-age-identity>` instead; that form needs `age` and the identity
where you run it.

## Restoring a backup

Restores are always manual. Before any restore, stop every service that writes to the data
(the managed services, and any other service that uses the database), keep the database
service itself running, and know which version the restored data belongs to: the backup was
made by the version named `<from>` in its name.

### PostgreSQL (`.pgdump`)

```sh
docker compose stop api worker
docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump \
  | docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'
```

- The dump is in custom format; `pg_restore` reads it from standard input.
- `--clean --if-exists` drops and recreates the objects that are **in the dump**. Tables,
  columns or indexes that only the new version created stay. If that matters (a later
  migration would trip over them), restore into a fresh database instead:

  ```sh
  docker compose exec -T db sh -c 'd="${POSTGRES_DB:-$POSTGRES_USER}"; dropdb -U "$POSTGRES_USER" --if-exists "$d" && createdb -U "$POSTGRES_USER" "$d"'
  docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump \
    | docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}"'
  ```

- If `hooks.backup.user` or `database` were set, use those names instead of the container's
  variables.
- `pg_restore` prints the errors it ignored at the end; read them.

### MySQL and MariaDB (`.sql.gz`)

```sh
docker compose stop api worker
docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.sql.gz \
  | gunzip \
  | docker compose exec -T db sh -c 'MYSQL_PWD="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" exec "$(command -v mariadb || command -v mysql)" -u root "${MYSQL_DATABASE:-$MARIADB_DATABASE}"'
```

- The dump contains `DROP TABLE IF EXISTS` and `CREATE TABLE` for every table it holds,
  plus routines, triggers and events. Tables that only the new version created stay; drop
  and recreate the database first for an exact state.
- `gunzip` runs on the host. If `hooks.backup.user` was set (or the root password is not in
  the container's environment), use that user and its password variable instead.

### Volumes (`.tar.gz`)

The archive has one top-level directory per configured volume (`./uploads/...`). Restore it
with a throwaway container of the sidecar's own image (it is already on the host and has
`tar`):

```sh
install -d -m 700 /root/restore
docker compose exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.tar.gz \
  > /root/restore/volumes.tar.gz
docker compose stop api worker                      # every service that mounts the volumes
docker run --rm --network none \
  --volume notes_uploads:/restore/uploads \
  --volume notes_sqlite-data:/restore/sqlite-data \
  --volume /root/restore:/in:ro \
  --entrypoint sh ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest> \
  -c 'for d in /restore/*/; do find "$d" -mindepth 1 -delete; done; tar -xzf /in/volumes.tar.gz -C /restore'
rm /root/restore/volumes.tar.gz
```

- Use the real volume names (`docker volume ls`, usually `<project>_<name>`, or the `name:`
  of the volume in the Compose file).
- The `find` empties each mounted volume first, so files the new version created do not
  survive. To restore only some volumes, mount only those; the other directories of the
  archive land in the throwaway container and disappear with it.
- `tar` running as root restores owners and modes as archived. Check them afterwards
  (`ls -ln` in a container that mounts the volume).

### Command backups (`.bin`)

The file is whatever your backup container wrote. Copy it off with `backups cat` and restore
it with the tool that created it (for example `mongorestore --archive --gzip`), with the
app's writers stopped.

## Runbook: a run ended in needs_attention

`needs_attention` means: the run failed after the point of no return, and the sidecar could
not be certain that starting the previous version is safe (or starting it failed, or the
sidecar restarted during the run). The sidecar has:

- stopped every managed service with `stopOnAttention: true` (not after an interruption:
  then it touched nothing),
- left the env file as the failure left it (with the new references if the failure came
  after the `start` step), and recorded the previous lines,
- kept the backup and protected it from retention,
- recorded the recovery information in the run.

An edge that keeps running (`stopOnAttention: false`) keeps showing the maintenance page.
Nothing happens automatically from here; you decide.

### 1. Read what happened

```sh
docker compose exec updater cicd-updater status
docker compose exec updater cicd-updater logs          # the run log; read it before you acknowledge
docker compose exec updater cicd-updater recover show
docker compose ps -a
```

`recover show` prints the facts and the rendered commands:

```
Run r-1793642651000-3fa2: needs_attention, failure health.timeout, schema changed: true
from version: 1.3.0
backup: notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump (48213377 bytes, sha256 9c0e...)
previous image of api: ghcr.io/acme/notes:1.3.0@sha256:...
previous image of worker: ghcr.io/acme/notes:1.3.0@sha256:...
previous image of web: ghcr.io/acme/notes-web:1.3.0@sha256:...
Commands (review before running them on the host):
  docker compose -p notes --profile updater stop api worker
  docker compose -p notes --profile updater exec -T updater cicd-updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump | docker compose -p notes --profile updater exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'
  docker compose -p notes --profile updater exec updater cicd-updater recover restore-env r-1793642651000-3fa2
  docker compose -p notes --profile updater up -d
```

The commands are rendered for display. Review each one before you run it. The commands that
stream data use `exec -T`; the `restore-env` line runs without `-T` on purpose: it shows the
lines it will write and asks before writing, so run it in a terminal (or append `--yes` in a
script).

`recover show --json` prints the recovery object: `backup`, `fromVersion`,
`previousImages`, `previousEnv` (per key `{ present, line }`) and `commands`.

### 2. Decide: back or forward

| `failure.schemaChanged` | What it means | Usual decision |
| --- | --- | --- |
| `true` | the probe value changed: the new version changed the schema. The previous version must not run on this database. | go back with a database restore, or go forward if the cause is fixable |
| `null` | unknown: no probe, the probe failed, the freeze failed, `rollback.policy: never`, or the sidecar was interrupted | treat it as changed, unless you can show otherwise (run the probe query by hand and compare with the backup) |
| `false` | the schema is unchanged, but the rollback itself failed (both reasons are in the detail) | go back without a database restore, after fixing why the previous version did not start |

Read the failure code and detail (see [troubleshooting](troubleshooting.md#failure-codes)).
A cause outside the release (a health timeout that is too short, a missing env value, a full
disk, a registry outage) often makes going forward the shorter path. A defect in the release
(a failing migration, a crashing image) makes going back the safe path.

### 3a. Go back to the previous version

1. Stop the writers. The `stopOnAttention` services are already stopped; stop any other
   service that writes to the database:

   ```sh
   docker compose stop api worker
   ```

2. Restore the database (skip this when `schemaChanged` is `false`). Use the rendered command
   or the steps in [Restoring a backup](#restoring-a-backup). For an encrypted backup see
   [Encryption](#encryption).
3. Write the previous lines of the writable keys back into the env file:

   ```sh
   docker compose exec updater cicd-updater recover restore-env r-1793642651000-3fa2
   # restore: APP_IMAGE=ghcr.io/acme/notes:1.3.0@sha256:...
   # restore: WEB_IMAGE=ghcr.io/acme/notes-web:1.3.0@sha256:...
   # Write these lines to the env file? [y/N]
   ```

   It writes the captured lines byte for byte (and removes keys that were absent before),
   touches no other line, and works from `status.json` directly, without the sidecar's HTTP
   server. In a script: `docker compose exec -T updater cicd-updater recover restore-env <runId> --yes`.
4. Start everything with the previous references:

   ```sh
   docker compose --profile updater up -d
   ```

5. Check the app: `docker compose ps`, its health endpoint, and
   `docker compose exec updater cicd-updater status` (the running version should be the
   previous one).
6. Acknowledge the run: `docker compose exec updater cicd-updater ack`.

### 3b. Go forward

1. Fix the cause (configuration, env file, disk space, network).
2. If the failure came after the `start` step, the env file already holds the new references.
   Start the app with them and check it:

   ```sh
   docker compose --profile updater up -d
   docker compose ps
   ```

   If the failure came earlier (in `stop` or `migrate`), the env file still holds the
   previous references; write the new ones yourself (the run's `images` field in
   `status --json` lists them) or schedule the update again once the app runs.
3. When the app runs and reports the new version, acknowledge the run:
   `docker compose exec updater cicd-updater ack`.

A fixed release can be installed through the sidecar only when the running version can be
determined. With the app stopped that is often not the case (refusal
`running_version_unknown`). Bring the app to a consistent, running state first.

### After the incident

- Keep the backup until you are sure you no longer need it; it stays protected until a later
  run ends in `needs_attention`.
- If the release was defective, publish a fixed version. Never move or reuse a tag.
- Consider what would have allowed an automatic rollback: a migration probe with a preset,
  `hooks.migrate` instead of migrations at container start, a longer health timeout.

## When the sidecar itself is broken

The app does not depend on the sidecar: when the sidecar is down, the app keeps running and
can be updated by hand (see [getting started](getting-started.md#updating-by-hand)). A
scheduled run that the sidecar misses ends `missed_start` (outcome `unchanged`) when it
comes back.

### Find out why

```sh
docker compose ps -a updater
docker compose logs --tail 100 updater
```

| Exit code | Meaning | Fix |
| --- | --- | --- |
| 64 | invalid configuration, token file or registry auth file; the log lists the problems | fix them, check with `docker compose run --rm --no-deps updater config check` |
| 75 | another container holds the state lock (`/state/.lock`) with a fresh heartbeat | stop the other sidecar; a stale lock (older than 60 seconds) is taken over automatically |

An unreadable or invalid `status.json` does not stop the sidecar: it is moved aside as
`status.json.corrupt-<epoch ms>`, and the sidecar continues `idle` without history.

### Run CLI commands without the server

These commands do not need the sidecar's HTTP server: `version`, `config check`, `doctor`,
`backups cat`, `recover restore-env`, `maintenance-page export`. When the `updater` container
cannot run, start a one-off container of the same service (same image, environment and
volumes); the command replaces `serve`:

```sh
docker compose run --rm --no-deps -T updater backups cat notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump > backup.pgdump
docker compose run --rm --no-deps updater recover restore-env r-1793642651000-3fa2
```

They still need a valid configuration (the project directory, the env file and the
writable keys come from it).

### Read the state volume directly

If no cicd-updater command can run at all, everything is in the state volume (usually
`<project>_updater-state`). Read it with a throwaway container of the sidecar image (no pull
needed) or, as root, under Docker's data root (by default
`/var/lib/docker/volumes/<volume>/_data/`):

```sh
docker run --rm --network none --volume notes_updater-state:/state:ro \
  --entrypoint cat ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest> /state/status.json > status.json
docker run --rm --network none --volume notes_updater-state:/state:ro \
  --entrypoint cat ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest> \
  /state/backups/notes-20261102-180411Z-1.3.0-to-1.4.0.pgdump > backup.pgdump
```

In `status.json` the previous env lines of a `needs_attention` run are in
`run.recovery.previousEnv` (current run) or `history[].recovery.previousEnv` (finished runs),
one entry per writable key: `{ "present": true, "line": "APP_IMAGE=..." }`. To restore by
hand, replace the last line of each key in the env file with `line`, or remove the key when
`present` is `false`. `recovery.previousImages` lists the image each managed service ran.

Do not edit `status.json` while a sidecar runs. It is internal; its format can change between
versions.

### Remove the sidecar

To take the sidecar out entirely:

```sh
docker compose --profile updater stop updater
docker compose --profile updater rm -f updater
```

Start the project without the `updater` profile from then on. The volumes `updater-state`,
`updater-shared` and `updater-verify` keep the state and the backups until you remove them
with `docker volume rm`.
