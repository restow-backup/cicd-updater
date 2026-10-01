/**
 * The app's own version, baked into the image at build time (Dockerfile ARG
 * VERSION, filled by the cicd-updater build action). Only the updater gets to
 * see it (src/server.ts, /healthz).
 */
export const APP_VERSION: string = (process.env.APP_VERSION ?? "0.0.0-dev").replace(/^v/, "");
