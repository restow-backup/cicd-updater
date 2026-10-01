/**
 * The sidecar's version. Release builds replace `__CICD_UPDATER_VERSION__`
 * (tsup `define`, from package.json); source runs report a development version.
 */
declare const __CICD_UPDATER_VERSION__: string | undefined;

export const SIDECAR_VERSION: string =
  typeof __CICD_UPDATER_VERSION__ === "string" ? __CICD_UPDATER_VERSION__ : "1.0.0-dev";
