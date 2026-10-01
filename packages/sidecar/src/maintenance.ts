import * as fs from "node:fs/promises";
import * as path from "node:path";
import { catalogs, type Messages, type UpdaterConfig } from "@cicd-updater/protocol";

/**
 * The optional maintenance page (design 4.3 `maintenancePage`, 6.2): a static
 * page served under `/public/v1/maintenance/` that polls the public status and
 * reloads the app when the update is over. Branding comes from a JSON file;
 * `templateDir` replaces `index.html` and `maintenance.css` (the script stays
 * built in). `cicd-updater maintenance-page export` writes the same files for
 * edges that serve files themselves.
 */

export interface Branding {
  productName: string;
  accentColor: string;
  supportUrl: string | null;
  logo: { name: string; type: string; body: Buffer } | null;
}

export interface PageFile {
  type: string;
  body: string | Buffer;
}

const DEFAULT_BRANDING: Branding = {
  productName: "",
  accentColor: "#2563eb",
  supportUrl: null,
  logo: null,
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Read and validate the branding file; invalid entries fall back to defaults. */
export async function loadBranding(file: string | null): Promise<Branding> {
  if (!file) {
    return DEFAULT_BRANDING;
  }
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const branding: Branding = { ...DEFAULT_BRANDING };
  if (typeof raw.productName === "string") {
    branding.productName = raw.productName.slice(0, 100);
  }
  if (typeof raw.accentColor === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(raw.accentColor)) {
    branding.accentColor = raw.accentColor;
  }
  if (typeof raw.supportUrl === "string" && /^https:\/\/[^\s"<>]+$/.test(raw.supportUrl)) {
    branding.supportUrl = raw.supportUrl;
  }
  if (
    typeof raw.logoFile === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|svg)$/.test(raw.logoFile)
  ) {
    const logoPath = path.join(path.dirname(file), raw.logoFile);
    const body = await fs.readFile(logoPath);
    if (body.length <= 256 * 1024) {
      const svg = raw.logoFile.endsWith(".svg");
      branding.logo = {
        name: svg ? "logo.svg" : "logo.png",
        type: svg ? "image/svg+xml" : "image/png",
        body,
      };
    }
  }
  return branding;
}

function catalogSubset(
  languages: readonly string[],
): Record<
  string,
  Pick<
    Messages,
    "phases" | "outcomes" | "steps" | "messages" | "messagesWithoutVersion" | "failures" | "ui"
  >
> {
  const subset: Record<
    string,
    Pick<
      Messages,
      "phases" | "outcomes" | "steps" | "messages" | "messagesWithoutVersion" | "failures" | "ui"
    >
  > = {};
  for (const language of languages) {
    const catalog = catalogs[language];
    if (catalog) {
      const { phases, outcomes, steps, messages, messagesWithoutVersion, failures, ui } = catalog;
      subset[language] = {
        phases,
        outcomes,
        steps,
        messages,
        messagesWithoutVersion: messagesWithoutVersion ?? {},
        failures,
        ui,
      };
    }
  }
  return subset;
}

export const MAINTENANCE_CSS = `:root {
  --accent: #2563eb;
  --bg: #f8fafc;
  --fg: #0f172a;
  --muted: #475569;
  --card: #ffffff;
  --border: #e2e8f0;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b1120; --fg: #e2e8f0; --muted: #94a3b8; --card: #111827; --border: #1f2937; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; }
main { width: 100%; max-width: 32rem; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
header img { max-height: 40px; max-width: 160px; }
h1 { font-size: 1.25rem; margin: 0; }
p { margin: 8px 0; color: var(--muted); }
.progress { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; margin: 16px 0 8px; }
.progress > div { height: 100%; width: 0; background: var(--accent); transition: width .4s ease; }
ol { list-style: none; padding: 0; margin: 16px 0 0; }
li { padding: 2px 0 2px 22px; position: relative; color: var(--muted); }
li::before { content: "○"; position: absolute; left: 0; }
li[data-status="running"] { color: var(--fg); font-weight: 600; }
li[data-status="running"]::before { content: "●"; color: var(--accent); }
li[data-status="done"]::before, li[data-status="skipped"]::before { content: "✓"; }
li[data-status="failed"]::before { content: "✕"; color: #dc2626; }
footer { margin-top: 16px; font-size: .875rem; color: var(--muted); }
a { color: var(--accent); }
`;

/** The page script: polls the public status, shows progress, reloads the app at the end. */
export const MAINTENANCE_JS = `(function () {
  "use strict";
  var root = document.documentElement;
  var statusUrl = root.getAttribute("data-status-url") || "/public/v1/status";
  var homeUrl = root.getAttribute("data-home-url") || "/";
  var catalogs = JSON.parse(document.getElementById("catalogs").textContent || "{}");
  var languages = Object.keys(catalogs);
  var wanted = (navigator.language || "en").toLowerCase().split("-")[0];
  var t = catalogs[wanted] || catalogs.en || catalogs[languages[0]];
  root.lang = catalogs[wanted] ? wanted : (catalogs.en ? "en" : languages[0]);
  var offset = 0;
  var samples = [];
  var reloadAt = 0;
  var seenRun = null;
  function el(id) { return document.getElementById(id); }
  function fill(template, params) {
    return String(template).replace(/\\{([A-Za-z0-9_]+)\\}/g, function (all, name) {
      return Object.prototype.hasOwnProperty.call(params || {}, name) ? String(params[name]) : all;
    });
  }
  function text(message) {
    if (!message) { return ""; }
    var has = function (table, key) { return Object.prototype.hasOwnProperty.call(table || {}, key); };
    if (!has(t.messages, message.code)) { return fill(t.ui.unknownCode, { code: message.code }); }
    var template = t.messages[message.code];
    if (template.indexOf("{version}") >= 0 && !has(message.params, "version") && has(t.messagesWithoutVersion, message.code)) {
      template = t.messagesWithoutVersion[message.code];
    }
    return fill(template, message.params);
  }
  function countdown(startsAt) {
    var seconds = Math.max(0, Math.round((Date.parse(startsAt) - (Date.now() + offset)) / 1000));
    if (seconds <= 0) { return t.ui.startingNow; }
    var h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    var time = (h > 0 ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s;
    return fill(t.ui.startsIn, { time: time });
  }
  function render(status) {
    var title = t.phases[status.phase] || status.phase;
    el("title").textContent = status.phase === "running" ? t.ui.maintenanceTitle : title;
    var body = status.phase === "scheduled" ? countdown(status.startsAt) : text(status.message);
    if (status.phase === "failed" && status.outcome && t.outcomes[status.outcome]) { body = t.outcomes[status.outcome]; }
    el("message").textContent = body || t.ui.maintenanceBody;
    el("bar").style.width = Math.max(0, Math.min(100, status.progress || 0)) + "%";
    el("progress").setAttribute("aria-valuenow", String(status.progress || 0));
    var list = el("steps");
    list.textContent = "";
    (status.steps || []).forEach(function (step) {
      if (step.status === "skipped") { return; }
      var item = document.createElement("li");
      item.setAttribute("data-status", step.status);
      item.textContent = t.steps[step.id] || step.id;
      list.appendChild(item);
    });
  }
  function schedule(status) {
    var active = status && (status.phase === "scheduled" || status.phase === "running");
    setTimeout(poll, active ? 2000 : 30000);
  }
  function poll() {
    fetch(statusUrl, { cache: "no-store", credentials: "omit" }).then(function (response) {
      if (!response.ok) { throw new Error("HTTP " + response.status); }
      return response.json();
    }).then(function (status) {
      if (status.serverTime) {
        samples.push(Date.parse(status.serverTime) - Date.now());
        if (samples.length > 8) { samples.shift(); }
        offset = Math.max.apply(null, samples);
      }
      if (status.runId) { seenRun = status.runId; }
      render(status);
      var over = status.phase === "succeeded" || (status.phase === "idle" && seenRun !== null);
      if (over && Date.now() > reloadAt) {
        reloadAt = Date.now() + 60000;
        setTimeout(function () { window.location.assign(homeUrl); }, 2500);
      }
      schedule(status);
    }).catch(function () {
      el("message").textContent = t.ui.maintenanceBody;
      schedule({ phase: "running" });
    });
  }
  el("hint").textContent = t.ui.reloadHint;
  poll();
})();
`;

/** Where the sidecar serves the page and the public status. */
export const DEFAULT_ASSET_BASE = "/public/v1/maintenance/";
export const DEFAULT_STATUS_URL = "/public/v1/status";

export interface PageOptions {
  /** URL of the public status (default /public/v1/status). */
  statusUrl?: string;
  /** Where the page goes when the update is over (default /). */
  homeUrl?: string;
  /** Prefix of the CSS, script and logo URLs (default /public/v1/maintenance/; "" for relative). */
  assetBase?: string;
}

export function renderIndexHtml(
  branding: Branding,
  languages: readonly string[],
  options: PageOptions = {},
): string {
  const name = branding.productName ? escapeHtml(branding.productName) : "";
  // Absolute by default: an edge serves the page in place of any address of the app
  // (an error fallback), where relative URLs would point elsewhere.
  const assets = escapeHtml(options.assetBase ?? DEFAULT_ASSET_BASE);
  const catalogsJson = JSON.stringify(catalogSubset(languages)).replace(/</g, "\\u003c");
  const first = catalogs[languages[0] ?? "en"] ?? catalogs.en;
  return `<!doctype html>
<html lang="${escapeHtml(first?.locale ?? "en")}" data-status-url="${escapeHtml(options.statusUrl ?? DEFAULT_STATUS_URL)}" data-home-url="${escapeHtml(options.homeUrl ?? "/")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name ? `${name} – ` : ""}${escapeHtml(first?.ui.maintenanceTitle ?? "Maintenance")}</title>
<link rel="stylesheet" href="${assets}maintenance.css">
<style>:root { --accent: ${branding.accentColor}; }</style>
</head>
<body>
<main>
<header>${branding.logo ? `<img src="${assets}${branding.logo.name}" alt="${name}">` : ""}<h1 id="title">${escapeHtml(first?.ui.maintenanceTitle ?? "Maintenance")}</h1></header>
<p id="message">${escapeHtml(first?.ui.maintenanceBody ?? "")}</p>
<div class="progress" id="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="bar"></div></div>
<ol id="steps"></ol>
<footer><span id="hint"></span>${branding.supportUrl ? ` <a href="${escapeHtml(branding.supportUrl)}" rel="noopener">${escapeHtml(branding.supportUrl)}</a>` : ""}</footer>
</main>
<script type="application/json" id="catalogs">${catalogsJson}</script>
<script src="${assets}maintenance.js"></script>
</body>
</html>
`;
}

/** Every file of the page, by name. */
export async function maintenanceFiles(
  config: Pick<UpdaterConfig, "maintenancePage">,
  options: PageOptions = {},
): Promise<Record<string, PageFile>> {
  const settings = config.maintenancePage;
  const branding = await loadBranding(settings.brandingFile);
  const files: Record<string, PageFile> = {
    "index.html": {
      type: "text/html; charset=utf-8",
      body: renderIndexHtml(branding, settings.languages, options),
    },
    "maintenance.css": { type: "text/css; charset=utf-8", body: MAINTENANCE_CSS },
    "maintenance.js": { type: "text/javascript; charset=utf-8", body: MAINTENANCE_JS },
  };
  if (branding.logo) {
    files[branding.logo.name] = { type: branding.logo.type, body: branding.logo.body };
  }
  if (settings.templateDir) {
    for (const name of ["index.html", "maintenance.css"]) {
      const custom = await fs
        .readFile(path.join(settings.templateDir, name), "utf8")
        .catch(() => null);
      if (custom !== null) {
        (files[name] as PageFile).body = custom;
      }
    }
  }
  return files;
}

/** The CSP the page is served with (the inline style only sets the validated accent color). */
export const MAINTENANCE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
