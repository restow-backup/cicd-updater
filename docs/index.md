# cicd-updater documentation

cicd-updater gives apps that run with Docker Compose signed, self-service updates: a CI
publishes signed images and a signed `release.json`, a sidecar on the host installs only
what those allow, and the app (or an operator with the CLI) only asks for an update.

Pick the group that matches your role. Every page is listed once.

## Start here

| Page | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | The quick start in detail, for each integration level (CLI only, any language, TypeScript). |
| [Concepts](concepts.md) | Sides, release document, trust modes, runs, phases, outcomes and the point of no return, in plain words. |
| [Architecture](architecture.md) | Components, data flow, volumes and networks. |
| [FAQ](faq.md) | Why not automatic updates, why no Kubernetes, why the Docker socket, why no self-update. |

## For operators

You run an app with Docker Compose and want to update it with the sidecar.

| Page | What it covers |
| --- | --- |
| [Configuration](configuration.md) | The complete `updater.yaml` reference and the `CICD_UPDATER_*` environment overrides. |
| [Trust modes](trust-modes.md) | `keyless`, `key` and `none` on both sides, identities for GitHub, GitLab and generic issuers, key rotation, the risks of `none`. |
| [Hooks](hooks.md) | Backup types, migration probe presets and fingerprint, separate migrations, health and smoke checks. |
| [CLI](cli.md) | Every `cicd-updater` command, its flags and exit codes. |
| [Maintenance page](maintenance-page.md) | The public status, edge configuration for Caddy, nginx and Traefik, branding. |
| [Registries](registries.md) | Registry auth files, mirrors and `cosign copy`, quirks of self-hosted registries. |
| [Backups and recovery](backups-and-recovery.md) | Retention, encryption, restoring each backup type, the runbook for `needs_attention`. |
| [Troubleshooting](troubleshooting.md) | Every failure code and blocker with cause and remedy, registry auth versus not found, `doctor` output. |
| [Upgrading the updater](upgrading-the-updater.md) | Verifying and pinning a new sidecar image, compatibility between versions. |
| [Security](security.md) | The security model, a hardening checklist, secrets, what is and is not verified. |

## For release engineers

You build and publish the app's releases.

| Page | What it covers |
| --- | --- |
| [Release side](release-side.md) | The release actions, the workflow templates, the release policy file, the smoke test, immutability. |
| [release.json](release-json.md) | The release document: schema reference, examples and validation rules. |
| [Feeds](feeds.md) | How releases are found: GitHub, Forgejo and Gitea, GitLab, static index; private repositories and tokens. |
| [CI: GitHub Actions](ci/github.md) | Step by step for GitHub Actions, with repository protections. |
| [CI: GitLab CI](ci/gitlab.md) | Step by step for GitLab CI, with protected tags. |
| [CI: Forgejo and Gitea Actions](ci/forgejo.md) | Step by step for Forgejo and Gitea Actions in `key` mode. |

## For app developers

You connect your app to the sidecar: an admin page, a banner for users, the audit log.

| Page | What it covers |
| --- | --- |
| [App integration](app-integration.md) | The app's jobs (authorization, step-up, audit, feed settings, notification, banner, health) with TypeScript and Python code. |
| [HTTP API](http-api.md) | Every endpoint of the sidecar, problem types, versioning and exactly-once journal ingestion. |
| [SDK](sdk.md) | The TypeScript package: client, feed check, token verifier, protocol, SemVer, messages, error handling. |
| [React](react.md) | The maintenance hooks and components, styling and translations. |
| [Web app template](../templates/web-app/README.md) | A copy-paste starter for an existing web app: Compose fragment, commented `updater.yaml`, release workflow, backend endpoints (TypeScript, Python, plain HTTP), the admin "Updates" page and the banner (React or plain JavaScript), an integration checklist. |

## Reference

| Page | What it covers |
| --- | --- |
| [Design](design.md) | The full design specification, normative for 1.0. |
| [State machine](state-machine.md) | Steps, failure codes, the rollback rule and resume after a restart. |
| [Threat model](threat-model.md) | Adversaries, mitigations and residual risks. |
| [Compatibility](compatibility.md) | The compatibility matrix with the recorded end-to-end test results. |
| [Versioning](versioning.md) | What the 1.x stability promise covers and what it does not. |
| [Decision records](adr/README.md) | One record per fundamental decision, with the alternatives that were considered. |

## Elsewhere in the repository

- [Examples](../examples/): `node-postgres` (TypeScript, SDK and React), `python-postgres`
  (Python, HTTP API) and `static-site` (CLI only).
- [Templates](../templates/): release workflows for GitHub, Forgejo and GitLab, and the
  [web app template](../templates/web-app/README.md).
- [OpenAPI document](../openapi/updater-api.v1.yaml) and [JSON Schemas](../schemas/).
- [SECURITY.md](../SECURITY.md) for reporting vulnerabilities, [CONTRIBUTING.md](../CONTRIBUTING.md),
  [CHANGELOG.md](../CHANGELOG.md).

cicd-updater is licensed under the Apache License 2.0, Copyright IT Systeme Flores UG
(haftungsbeschränkt). It was extracted from the opt-in updater of
[Restow](https://github.com/restow-backup/restow) (Apache-2.0).
