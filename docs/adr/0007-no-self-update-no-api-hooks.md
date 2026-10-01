# 0007. The sidecar never updates itself and never runs what it installed

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 7 of section 0) |

## Context

The sidecar holds the Docker socket, which is root on the host: with it, any container
with any mount can be started. Whatever can change the sidecar's own image, or make it
execute commands chosen by a caller, is a path to the host.

The app holds the token for the sidecar's API. A compromised app must not become a
compromised host.

## Decision

- **No self-update.** The operator pins the sidecar's image (by digest, recommended). The
  sidecar never installs a new version of itself; with `selfCheck.enabled` it only reports
  that one exists.
- **Never a writable key.** Before a run, a Compose probe checks that the sidecar's own
  service does not take its image from a key the sidecar rewrites; otherwise the run is
  refused (blocker `updater_image_unpinned`). The container holding the socket therefore
  never runs an image the sidecar installed.
- **Hooks only from `updater.yaml`.** Backup, migration probe, migration, health and smoke
  commands come only from the configuration file, which only the host operator writes.
- **A minimal API.** The API offers scheduling of signed, newer releases from the
  configured feed and nothing else. No endpoint runs a command or chooses an image, a
  repository, a hook or a file. In source mode the repository also comes from the
  configuration.

## Consequences

- A compromised app can at most force an update to a legitimate newer release, cancel a
  run, and read the update state and backup metadata
  ([threat model](../threat-model.md), T4).
- The container holding the socket changes only by operator action. Operators update the
  sidecar by hand after verifying the new image
  ([upgrading the updater](../upgrading-the-updater.md)).
- A release can require a newer sidecar (`requires.updater`); an older one refuses with
  `updater_too_old` instead of installing it.
- Apps cannot add custom update steps through the API; they ask the operator to configure
  hooks.

## Alternatives considered

- **Self-update of the sidecar.** Rejected: the container holding the socket would change
  without operator action, and a failed self-update could leave the host without a working
  updater in the middle of a run.
- **Hooks or commands in API requests.** Rejected: whoever holds the token would control
  root on the host.
