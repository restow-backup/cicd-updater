import {
  MaintenanceBanner,
  type MaintenanceView,
  UpdateProgress,
  useMaintenance,
} from "@restow-backup/cicd-updater/react";
import { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * The admin page: the maintenance banner and progress for everyone (they poll the
 * app's /api/maintenance and, while the api is down, the edge's public status),
 * and an update form for the admin. Styling is left to the app (data-state hooks).
 */

async function fetchMaintenance(): Promise<MaintenanceView> {
  const response = await fetch("/api/maintenance", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(String(response.status));
  }
  return (await response.json()) as MaintenanceView;
}

async function fetchPublicStatus(): Promise<MaintenanceView | null> {
  const response = await fetch("/public/v1/status", { cache: "no-store" });
  return response.ok ? ((await response.json()) as MaintenanceView) : null;
}

function UpdateForm() {
  const [token, setToken] = useState("");
  const [version, setVersion] = useState("");
  const [result, setResult] = useState<string | null>(null);

  async function schedule(event: FormEvent): Promise<void> {
    event.preventDefault();
    const response = await fetch("/api/admin/updates", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version, leadSeconds: 300 }),
    });
    const body = (await response.json()) as { code?: string };
    setResult(
      response.ok ? `Update to ${version} scheduled in 5 minutes.` : `Refused: ${body.code}`,
    );
  }

  return (
    <form onSubmit={schedule} className="update-form">
      <label>
        Admin token{" "}
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <label>
        Version{" "}
        <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.1.0" />
      </label>
      <button type="submit">Schedule update</button>
      {result ? <p role="status">{result}</p> : null}
    </form>
  );
}

function App() {
  const snapshot = useMaintenance({ fetchMaintenance, fetchPublicStatus });
  return (
    <>
      <MaintenanceBanner snapshot={snapshot} className="banner" />
      <UpdateProgress snapshot={snapshot} className="progress" />
      <UpdateForm />
    </>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
