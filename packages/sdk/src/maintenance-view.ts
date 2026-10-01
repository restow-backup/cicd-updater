import { type PublicStatus, publicStatusOf, type StateView } from "@cicd-updater/protocol";

/**
 * What the app's own maintenance endpoint returns to every signed-in user
 * (design 7.6): the public status plus the versions.
 */
export type MaintenanceView = PublicStatus;

export function maintenanceViewOf(
  state: StateView | null,
  now: Date = new Date(),
): MaintenanceView {
  if (!state) {
    return publicStatusOf("idle", null, now);
  }
  return publicStatusOf(state.phase, state.run as never, now, true);
}
