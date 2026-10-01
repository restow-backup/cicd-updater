# Contributing

Thank you for helping. This file explains how to set up the repository, the rules the
code follows, and how contributions are signed off.

Security issues are not reported as public issues: see [SECURITY.md](SECURITY.md).

## Setup

- Node.js 22 or 24 (`.nvmrc`), pnpm 9 (`corepack enable` picks the version in `package.json`)
- Docker with Compose v2 only for the end-to-end tests and the image build

```sh
pnpm install
pnpm typecheck        # tsc for every package and the scripts
pnpm lint             # Biome (lint and format check); pnpm format writes the formatting
pnpm test             # Vitest, all unit tests
pnpm test:coverage    # with the coverage gate (90 % lines for engine and protocol)
pnpm lint:actions     # pins, inputs and shell scripts of actions, templates and example workflows
```

The test runner uses at most three workers; `VITEST_MAX_WORKERS` (or `VITEST_MAX_FORKS`,
`VITEST_MAX_THREADS`) can lower that.

Generated files are committed and checked for drift in CI. After you change their sources,
regenerate and commit them:

| Change | Command | Files |
| --- | --- | --- |
| a schema, config key or API shape in `packages/protocol` | `pnpm generate` | `schemas/`, `openapi/`, the reference section of `docs/configuration.md` |
| `packages/release-tools` | `pnpm bundle` | `actions/lib/release-tools.mjs` |
| runtime dependencies | `pnpm notices` | `THIRD_PARTY_NOTICES` |

## Layout

| Path | Content |
| --- | --- |
| `packages/protocol` | zod schemas, codes, messages, SemVer; the contracts (no Node.js APIs) |
| `packages/feed` | release feed providers behind the SSRF guard |
| `packages/engine` | the update state machine; talks to the world only through ports |
| `packages/sidecar` | the sidecar process: Docker and Compose, hooks, backups, verifier, HTTP API, CLI |
| `packages/release-tools` | the release side: build, smoke, index, signing, release.json, upload |
| `packages/sdk` | the published SDK `@restow-backup/cicd-updater` |
| `actions/`, `templates/` | composite actions and copyable release workflows |
| `docker/` | the sidecar image |
| `examples/` | complete example projects |

A boundary test (`scripts/test/boundary.test.ts`) keeps each package to its allowed imports.

## Rules the code follows

- **No shell strings.** Commands are argument vectors. The few scripts that run inside other
  containers are constants with parameters passed as arguments or environment variables
  (`packages/sidecar/src/hooks.ts`, `backup.ts`).
- **No secrets in argv or child environments.** Tokens and passwords travel through files
  with mode 0600 or the environment of the one program that needs them, and every log line
  passes the redactor.
- **Codes, not prose.** Failures, blockers, warnings and messages are codes from
  `packages/protocol/src/codes.ts` with texts in `messages.ts`. Clients render codes;
  log texts are not a contract.
- **State before side effect.** The engine persists what it is about to do (for example
  `applyAttempted`, `envWritten`) before it does it, so a restart can always tell what happened.
- **Contracts are additive in 1.x.** `release.json` schema 1, `updater.yaml` version 1, the HTTP
  API `/v1`, the codes, the SDK exports, the CLI and the action inputs follow
  [docs/versioning.md](docs/versioning.md).

### Adding a failure code

1. Add it to `FAILURE_CODES` (and its step) in `packages/protocol/src/codes.ts`.
2. Add the English and German texts in `packages/protocol/src/messages.ts`.
3. Raise it in the engine or the sidecar and cover it with a test.
4. Document cause and remedy in `docs/troubleshooting.md`.

### Adding a configuration key

1. Add it with its default and a `.meta({ description })` to `packages/protocol/src/config.ts`;
   cross-field rules go into `crossFieldRules`.
2. Run `pnpm generate` (JSON Schema, configuration reference, environment override name).
3. Use it, test it, and mention it in `CHANGELOG.md` under "Added".

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) (`feat(engine): ...`,
  `fix(sidecar): ...`, `docs: ...`).
- Every commit carries a `Signed-off-by:` line (see below).
- One topic per pull request, with tests. CI must be green.
- Contract changes are named in `CHANGELOG.md` under `Unreleased`.

## Developer Certificate of Origin

Contributions are accepted under the Apache License 2.0 with a sign-off according to the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): by adding a
`Signed-off-by` line to a commit, you certify that you wrote the change or otherwise have
the right to submit it under the project's license.

```sh
git commit -s -m "fix(feed): ..."
```

The line must carry your real name and an email address you can be reached at:

```
Signed-off-by: Jane Doe <jane@example.com>
```
