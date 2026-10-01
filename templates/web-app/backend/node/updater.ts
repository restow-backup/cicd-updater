import { createUpdaterClient } from "@restow-backup/cicd-updater";

/**
 * cicd-updater: the app's one client for the sidecar (docs/sdk.md).
 *
 * The sidecar is opt-in. When UPDATER_URL is empty, or the token file does not exist
 * (the `updater` profile is not running), `updater.state()` resolves `null` and every
 * other method throws `UpdaterUnavailableError`. The app keeps working and the admin
 * page shows the manual update steps.
 */

/** The shared token, mounted read-only into this container (compose/docker-compose.updater.yml). */
export const UPDATER_TOKEN_FILE = process.env.UPDATER_TOKEN_FILE ?? "/run/cicd-updater/token";

export const updater = createUpdaterClient({
  url: process.env.UPDATER_URL ?? "",
  tokenFile: UPDATER_TOKEN_FILE,
});
