import type { ReleasesView, StateView } from "@restow-backup/cicd-updater/protocol";
import type { MaintenanceView } from "@restow-backup/cicd-updater/react";

/**
 * cicd-updater: the browser's calls to YOUR app's endpoints (backend/node/updates.ts,
 * backend/python/updates.py). The browser never talks to the sidecar's authenticated API.
 * Only while the app is down for the update does it read the public status through the
 * edge (`/public/v1/status`).
 */

/** TODO(cicd-updater): the path prefix of your API (the backend's `basePath`). */
const API = "/api";

/** The body of `GET /api/admin/updates`. */
export interface AdminUpdatesView {
  /** null: no sidecar on this installation; show the manual update steps. */
  state: StateView | null;
  leadTimes: readonly number[];
  stepUpMaxAgeSeconds: number;
}

/** An error answer of your backend: `{ code, ... }`, or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: {
      blockers?: { code: string; detail: string | null }[];
      reasons?: string[];
      feedError?: string;
      field?: string;
    } = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      // POST bodies are always JSON (the backend refuses anything else).
      // TODO(cicd-updater): add your CSRF header here if your app uses one.
      headers: method === "POST" ? { "content-type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const problem = (parsed ?? {}) as { code?: unknown };
    const code = typeof problem.code === "string" ? problem.code : `http_${response.status}`;
    throw new ApiError(response.status, code, (parsed ?? {}) as ApiError["body"]);
  }
  return parsed as T;
}

export const updatesApi = {
  status: () => call<AdminUpdatesView>("GET", "/admin/updates"),
  releases: (refresh = false) =>
    call<ReleasesView>("GET", `/admin/updates/releases${refresh ? "?refresh=1" : ""}`),
  schedule: (input: { version: string; leadSeconds: number; releaseSha256: string }) =>
    call<StateView>("POST", "/admin/updates", input),
  cancel: (runId: string) =>
    call<StateView>("POST", `/admin/updates/${encodeURIComponent(runId)}/cancel`),
  acknowledge: (runId: string) =>
    call<StateView>("POST", `/admin/updates/${encodeURIComponent(runId)}/acknowledge`),
};

/** For `useMaintenance`: must throw when the app does not answer (that switches to the fallback). */
export async function fetchMaintenance(): Promise<MaintenanceView> {
  const response = await fetch(`${API}/maintenance`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(String(response.status));
  }
  return (await response.json()) as MaintenanceView;
}

/** The sidecar's public status through your edge, while the app is down. */
export async function fetchPublicStatus(): Promise<MaintenanceView | null> {
  const response = await fetch("/public/v1/status", { cache: "no-store" });
  return response.ok ? ((await response.json()) as MaintenanceView) : null;
}
