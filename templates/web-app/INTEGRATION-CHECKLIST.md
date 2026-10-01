# Integration checklist

Tick these off while you integrate the template; the last block is for every release
afterwards. Details: [app integration](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md#checklist),
[security hardening](https://github.com/restow-backup/cicd-updater/blob/main/docs/security.md#hardening-checklist).

## Release side

- [ ] `.github/workflows/release.yml` (or the Forgejo/GitLab template) is in the repository,
      with the file name the sidecar's trust identity names.
- [ ] The cicd-updater actions are pinned to the commit SHA of the reviewed release.
- [ ] `.cicd-updater/release-policy.yaml` exists and is reviewed with every release.
- [ ] `.env.example` lists every variable the Compose files use (optional ones commented).
- [ ] `docker-compose.smoke.yml` publishes the health endpoint on the runner's loopback.
- [ ] The Dockerfile turns the build argument `VERSION` into `APP_VERSION`.
- [ ] Release tags and the default branch are protected; signing secrets or OIDC tokens are
      available only to the job that signs.
- [ ] The first release `v1.0.0` is published with `release.json` and
      `release.json.sigstore.json`.

## Host

- [ ] The sidecar image is verified with cosign and pinned by digest in `CICD_UPDATER_IMAGE`,
      a variable the sidecar never writes.
- [ ] The `updater` service is in the `updater` profile, on the internal network only, without
      `ports:`, with `no-new-privileges`, the role label, `stop_grace_period: 30s`.
- [ ] `PROJECT_DIR` is the absolute project path; it is mounted at the same path.
- [ ] `APP_IMAGE` in `.env` is digest-pinned (`<repository>:<tag>@sha256:<digest>`).
- [ ] `updater.yaml` is owned by root, passes `config check`, and the app cannot write it.
- [ ] Trust mode is `keyless` or `key`. `none` only on a test installation.
- [ ] Backup type, migration probe preset and `rollback.policy` match the app; backups are
      encrypted with `ageRecipients`, the private key is off the host.
- [ ] `cicd-updater doctor` shows no `FAIL` line; `cicd-updater status` says `ready: yes`.

## App

- [ ] The token volume is mounted read-only into the backend only; `auth.tokenGroupId`
      matches the backend's group when it runs as non-root.
- [ ] The app starts and works without the sidecar (no token file: no updates page actions,
      manual steps shown).
- [ ] `/healthz` answers readiness to everyone and `version` only to the sidecar's token.
- [ ] Only installation admins may read the admin endpoints and schedule, cancel and
      acknowledge; impersonated sessions never count.
- [ ] Scheduling requires a strong sign-in younger than 10 minutes; the UI handles
      `step_up_required`.
- [ ] Every action passes `requestedBy`; scheduling passes `expect.releaseSha256`.
- [ ] POST endpoints accept JSON only and your CSRF protection covers them.
- [ ] Denied and refused attempts are written to the audit log; the sidecar's journal is
      ingested exactly once (cursor and audit entry in one transaction).
- [ ] Every signed-in page shows the maintenance banner; the admin page is reachable only
      for installation admins.

## Edge

- [ ] `/public/v1/` is forwarded to `updater:8090`; nothing else of the sidecar is.
- [ ] 502, 503 and 504 of the app show `/public/v1/maintenance/`.
- [ ] Tested with the app stopped (`docker compose stop api`): the page appears.

## Every release

- [ ] Upgrade constraints in `release-policy.yaml` are current (`minimumFromVersion`,
      `requiresEnv`, `manualSteps`).
- [ ] Migrations are recorded by the migration tool, so the probe sees them.
- [ ] The release workflow passed the smoke test, including `upgrade-from: previous`.
