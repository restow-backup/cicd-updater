import { type Messages, messagesFor } from "@restow-backup/cicd-updater/messages";
import {
  MaintenanceBanner,
  UpdateProgress,
  useMaintenance,
} from "@restow-backup/cicd-updater/react";
import { fetchMaintenance, fetchPublicStatus } from "./api.js";

/**
 * cicd-updater: the banner every signed-in user sees (docs/react.md). Render it once, near
 * the root of your signed-in layout:
 *
 *   <MaintenanceNotice />
 *
 * - scheduled: "An update is scheduled. Starts in 4:12" (ticking, on the server's clock)
 * - running: the step and a progress bar
 * - finished: the result; after a successful update the page reloads once, so users get
 *   the new frontend
 *
 * While the app is down for the update, it polls the sidecar's public status through
 * your edge instead (the edge must forward /public/v1/, see the template's README).
 * Styling: the `update-banner` and `update-progress` classes in updates.css.
 */
export function MaintenanceNotice(props: { messages?: Messages }) {
  const snapshot = useMaintenance({ fetchMaintenance, fetchPublicStatus });
  const messages =
    props.messages ?? messagesFor(typeof navigator === "undefined" ? "en" : navigator.language);
  return (
    <>
      <MaintenanceBanner snapshot={snapshot} messages={messages} className="update-banner" />
      {snapshot.phase === "running" ? (
        <UpdateProgress snapshot={snapshot} messages={messages} className="update-progress" />
      ) : null}
    </>
  );
}
