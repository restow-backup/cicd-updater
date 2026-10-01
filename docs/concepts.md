# Concepts

This page explains the ideas behind cicd-updater in plain words. The exact rules are in the
[state machine](state-machine.md), the [configuration reference](configuration.md) and the
[design specification](design.md).

## Three sides, one contract

cicd-updater connects three parties that do not trust each other blindly:

| Side | What it is | What it does |
| --- | --- | --- |
| Release side | the CI of the app's repository | builds the images, smoke-tests them, signs them and publishes a signed `release.json` |
| Host side | the `cicd-updater` sidecar container next to the app | finds releases, verifies them, backs up, installs exactly the published images, checks the result |
| App side | the app itself (any language) | asks the sidecar for updates, decides who may start one, keeps the audit log, tells its users |

The sidecar installs only what the signed release document and the signatures allow. The app
can only ask; it cannot choose an image, a command or a repository.

## The release document

`release.json` is one small JSON document per release, published as a release asset. It
names the version and the Git tag, and for each image the repository, tag and the digest of
the multi-arch index. It also carries the upgrade constraints: the lowest version the release
may be installed over (`minimumFromVersion`), whether manual steps are required, the lowest
sidecar version it needs and the env keys that must be set.

The CI generates it from the digests it actually pushed and signs it. A signed document binds
version, digests and constraints together: someone who can edit release assets but cannot run
the release workflow cannot swap images, lower the minimum version or hide manual steps.
See [release.json](release-json.md).

## Feeds

The sidecar finds releases through a feed: the releases of a GitHub, Forgejo/Gitea or GitLab
repository, a static index file on any https host, or a directory mounted into the sidecar.
A release without a `release.json` asset is never installed in image mode. See
[feeds](feeds.md).

## Trust modes

The trust mode says how the sidecar establishes that a release is authentic. It is set on
both sides and never changes on its own.

| Mode | Trust anchor | Typical use |
| --- | --- | --- |
| `keyless` | the CI's OIDC identity: exactly this repository's release workflow at exactly this tag, recorded in Sigstore's public transparency log | GitHub Actions, GitLab CI |
| `key` | possession of a cosign private key; the sidecar holds the public keys | Forgejo/Gitea Actions, other CI, private infrastructure |
| `none` | only TLS of the release host and the registry; digests are still required and compared | test installations, fully private setups; must be acknowledged explicitly |

In `keyless` and `key` mode a missing or invalid signature always fails. The sidecar never
falls back to a weaker mode. See [trust modes](trust-modes.md).

## Managed services

A managed service is a Compose service whose image the sidecar replaces. `updater.yaml`
lists them, each with the image key of `release.json` it runs and the env variable it reads
its image from. Services the file does not list, such as the database, stay under the
operator's control.

Managed services are started in groups (`startOrder`). Each group must be healthy before
the next one starts, so an API can come up before the workers that depend on it.

## Writable keys

The sidecar changes exactly one file: the Compose env file (default `.env`). In that file it
changes only the writable keys: the `imageVar` of every managed service, plus
`env.versionVar` if you set one. Everything else in the file (comments, order, quoting, other
keys) stays byte for byte as it was. The code refuses to write any other key, whatever the
configuration says.

The value it writes is a digest-pinned reference, `repository:tag@sha256:...`. Because the
digest pins the content, a moved tag can never change what runs.

## Runs

A run is one update attempt, from scheduling to its end. Somebody schedules it (an admin in
the app, or the operator with the CLI) for now, for a lead time ("in 15 minutes") or for an
absolute time. Before the sidecar accepts it, it verifies the release document and (in
`keyless` and `key` mode) every image signature in the registry; what does not verify is
never announced. During the
countdown users see a banner, and the run can be moved or cancelled.

Only one run exists at a time. A finished run stays visible until it is acknowledged, so
every admin sees how it ended.

## Phases

The phase is the coarse state of the sidecar:

| Phase | Meaning |
| --- | --- |
| `idle` | nothing announced |
| `scheduled` | a run is announced and counting down |
| `running` | the steps are executing |
| `succeeded` | the run finished; the new version answers |
| `failed` | the run finished without success; the outcome says in which state the installation is |

## Steps

A running update goes through fixed steps: `prepare` (checks), `fetch` (verify signatures,
pull by digest), `backup`, `stop` (stop the writers), `migrate` (optional), `start`,
`health`, `smoke` (optional checks) and `finish` (cleanup). Steps that do not apply are
skipped. With a quiesced backup the `stop` step comes before the `backup`.

## The point of no return

The point of no return is the beginning of the `stop` step. Before it nothing was stopped or
replaced: a failure or a cancel leaves the installation exactly as it was. After it, the
sidecar has to decide how to end the run safely.

## Outcomes

Every finished run has one of four outcomes:

| Outcome | In plain words |
| --- | --- |
| `succeeded` | The new version runs and passed its checks. |
| `unchanged` | Something failed (or was aborted) before the point of no return. Nothing was changed. |
| `rolled_back` | Something failed after the point of no return. The sidecar was certain the data had not been changed by the new version, so it started the previous version again, and that version is healthy. |
| `needs_attention` | Something failed after the point of no return and going back was not certain to be safe (or going back failed, or the sidecar restarted mid-update). The sidecar stopped the app, kept the backup and recorded what to do. |

## Rolling back only when it is certain

Starting old code on a database that the new code already migrated can corrupt data. So the
sidecar rolls back only when one of these holds:

- nothing new had started yet (only services were stopped), or
- the app declares it has no persistent schema (`rollback.policy: always`), or
- a migration probe reads the same value after the update as before it, read while the new
  version is stopped (`rollback.policy: probe`).

Otherwise the run ends in `needs_attention`. The sidecar never guesses and never restores a
database on its own. See [the rollback rule](state-machine.md#the-rollback-rule).

## Backups and the migration probe

Before it applies the new images, the sidecar can back up the database (PostgreSQL,
MySQL/MariaDB), Docker volumes or the output of a custom command. Each backup is verified and can be
encrypted with `age`. The migration probe reads one value that changes when a migration runs
(for example the row count of the migration tool's table) plus, optionally, a fingerprint of
the column catalog. See [hooks](hooks.md) and [backups and recovery](backups-and-recovery.md).

## Health and the running version

After starting the new images the sidecar waits until every managed container runs (and is
Docker-healthy where a healthcheck exists) and the app's health check reports the new
version. The app reveals its version only to a caller that presents the shared token, so a
public visitor cannot learn which release (and which known vulnerability) is running.

## Recovery information

When a run ends in `needs_attention`, the run records the backup, the previous version, the
previous image of every managed service, the previous env file lines and the commands to
restore them. `cicd-updater recover show` prints them; restoring stays a decision of the
operator. See the [runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention).

## Journal and public status

The sidecar records every action (scheduled, rescheduled, cancelled, started, succeeded,
failed, acknowledged) as a journal event with an id the app reads with a cursor, so the
app's audit log gets each event exactly once, even across restarts.

The public status (`/public/v1/status`) is a read-only, unauthenticated view for the
maintenance page: phase, steps, progress and codes, no users, images, paths or logs, and no
versions unless you allow them. See [maintenance page](maintenance-page.md).

## The sidecar holds root

The sidecar holds the Docker socket, which is root on the host. Everything else follows from
that: it is opt-in, listens only on an internal network, takes hooks only from
`updater.yaml`, never updates itself and runs signature verification in an isolated
container. See [security](security.md).
