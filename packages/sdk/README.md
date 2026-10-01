# @restow-backup/cicd-updater

The app's side of [cicd-updater](https://github.com/restow-backup/cicd-updater): signed,
self-service updates for apps run with Docker Compose.

This package lets your app talk to the update sidecar, check the release feed without
becoming an SSRF tool, verify the sidecar's token on your health endpoint and show a
maintenance banner. It is ESM only, ships its own type declarations and has one runtime
dependency (`zod`); `react` is an optional peer.

## Install

From the GitHub release (always available):

```sh
npm install https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/restow-backup-cicd-updater-1.0.0.tgz
```

From npm, once it is published there:

```sh
npm install @restow-backup/cicd-updater@1.0.0
```

The imports are the same either way.

## Entry points

| Import | Runtime | Content |
| --- | --- | --- |
| `@restow-backup/cicd-updater` | Node.js 22 or newer | `createUpdaterClient`, `syncJournal`, errors, types |
| `@restow-backup/cicd-updater/feed` | Node.js 22 or newer | `checkFeed` with the SSRF guard |
| `@restow-backup/cicd-updater/auth` | Node.js 22 or newer | `createTokenVerifier` for the app's health endpoint |
| `@restow-backup/cicd-updater/protocol` | any | zod schemas and types of every document, codes, `progressOf` |
| `@restow-backup/cicd-updater/semver` | any | `parseVersion`, `compareVersions`, `isNewer`, `channelAllows`, `satisfiesRange` |
| `@restow-backup/cicd-updater/messages` | any | `en` and `de` catalogs for steps, messages, failures and blockers |
| `@restow-backup/cicd-updater/react` | browser, React 18 or newer | `useMaintenance`, `useCountdown`, `MaintenanceBanner`, `UpdateProgress` |

## Example

```ts
import { createUpdaterClient, UpdaterProblemError } from "@restow-backup/cicd-updater";

const updater = createUpdaterClient({
  url: process.env.UPDATER_URL ?? "",
  tokenFile: "/run/cicd-updater/token",
});

const state = await updater.state(); // null when no sidecar runs
if (state?.capabilities.ready && state.phase === "idle") {
  try {
    await updater.schedule({
      version: "1.4.0",
      leadSeconds: 300,
      requestedBy: { id: "user-42", label: "admin@example.com" },
    });
  } catch (error) {
    if (error instanceof UpdaterProblemError) {
      console.log(error.code, error.problem.detail);
    }
  }
}
```

The browser parts never talk to the sidecar. They talk to your app's own endpoints, and,
while the app is down during an update, to the public status through the edge.

## Documentation

- [SDK reference](https://github.com/restow-backup/cicd-updater/blob/main/docs/sdk.md)
- [React components](https://github.com/restow-backup/cicd-updater/blob/main/docs/react.md)
- [App integration](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md)
- [HTTP API](https://github.com/restow-backup/cicd-updater/blob/main/docs/http-api.md)

## License

Apache License 2.0. Copyright IT Systeme Flores UG (haftungsbeschränkt).
