import { startHost, stopHost } from "./host.js";

/** Start the Docker-in-Docker host once for the whole suite; remove it at the end. */
export async function setup(): Promise<void> {
  await startHost();
}

export async function teardown(): Promise<void> {
  await stopHost();
}
