import { afterEach, describe, expect, it } from "vitest";
import { Example } from "../lib/examples.js";
import { q, waitFor } from "../lib/exec.js";
import { sh } from "../lib/host.js";
import type { Project } from "../lib/project.js";

/**
 * The examples (design 10.7 `examples`, 11): each is built in two versions from its own
 * Dockerfiles, installed from its own Compose file and .env.example, and updated through
 * the sidecar with its own updater.yaml (file feed and the e2e key instead of keyless).
 * node-postgres goes through the app: the admin endpoint schedules with the SDK client,
 * health reveals the version only to the token, the journal lands in the audit log.
 */

let current: Project | null = null;

afterEach(async () => {
  await current?.down();
  current = null;
});

/** GET through the edge's published port, from inside the host. */
async function edge(url: string): Promise<{ status: number; body: string }> {
  const result = await sh(`wget -q -S -O - ${q(url)} 2>&1 || true`);
  const status = Number(/HTTP\/1\.1 (\d{3})/.exec(result.stdout)?.[1] ?? 0);
  return { status, body: result.stdout };
}

describe("node-postgres", () => {
  it("installs, and the admin endpoint updates it through the SDK with a migration", async () => {
    const adminToken = "e2e-admin-token-0123456789abcdef";
    const example = await Example.create({
      name: "node-postgres",
      project: "notes",
      images: {
        app: { variable: "APP_IMAGE", file: "app/Dockerfile" },
        web: { variable: "WEB_IMAGE", file: "web/Dockerfile" },
      },
      env: { POSTGRES_PASSWORD: "notes-db-password-e2e", ADMIN_TOKEN: adminToken },
    });
    await example.release("1.0.0");
    // 1.1.0 brings a migration (a new column), applied by hooks.migrate (node-pg-migrate 8).
    await sh(`cat > ${q(example.dir)}/app/migrations/1730000000001_tags.js <<'EOF'
/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.addColumn("notes", { tags: { type: "text[]", notNull: true, default: "{}" } });
};
export const down = false;
EOF`);
    await example.release("1.1.0");
    const project = await example.install("1.0.0");
    current = project;
    // First install: create the schema once (README, "From clone to the first update").
    await project.compose(["run", "--rm", "-T", "api", "npm", "run", "--silent", "migrate"]);
    await project.compose([
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "notes",
      "-d",
      "notes",
      "-c",
      "INSERT INTO notes (title) VALUES ('first'), ('second')",
    ]);

    // Health: readiness for everyone, the version only for the sidecar's token.
    const anonymous = await project.http("api", "http://api:3000/healthz");
    expect(JSON.parse(anonymous.body)).toEqual({ status: "ok" });
    const withToken = await project.http("api", "http://api:3000/healthz", await project.token());
    expect(JSON.parse(withToken.body)).toEqual({ status: "ok", version: "1.0.0" });
    expect((await project.state()).running.version).toBe("1.0.0");

    // The admin page's backend schedules through the SDK client (leadSeconds 0).
    const admin = await project.http("api", "http://api:3000/api/admin/updates", adminToken);
    const listed = JSON.parse(admin.body) as {
      releases: { releases: { version: string; releaseSha256: string | null }[] };
    };
    const target = listed.releases.releases.find((release) => release.version === "1.1.0");
    expect(target?.releaseSha256).toMatch(/^[0-9a-f]{64}$/);
    const scheduled = await project.http("api", "http://api:3000/api/admin/updates", adminToken, {
      method: "POST",
      body: { version: "1.1.0", leadSeconds: 0, releaseSha256: target?.releaseSha256 },
    });
    expect(scheduled.status).toBe(202);
    const run = await project.finished();
    expect(run.failure).toBeNull();
    expect(run.outcome).toBe("succeeded");
    expect(run.verification).toEqual({ signatures: "verified", digests: "verified" });
    const migrate = run.steps.find((step) => step.id === "migrate");
    expect(migrate?.status).toBe("done");
    expect(await project.envValue("APP_IMAGE")).toBe(example.ref("1.1.0", "app"));
    expect(await project.envValue("WEB_IMAGE")).toBe(example.ref("1.1.0", "web"));
    const columns = await project.compose([
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "notes",
      "-d",
      "notes",
      "-At",
      "-c",
      "SELECT count(*) FROM notes WHERE tags = '{}'",
    ]);
    expect(columns.stdout.trim()).toBe("2");

    // The banner endpoint and the edge's smoke path.
    const maintenance = JSON.parse(
      (await project.http("api", "http://api:3000/api/maintenance")).body,
    );
    expect(maintenance.phase).toBe("succeeded");
    expect((await edge("http://127.0.0.1:8080/api/ping")).body).toContain("pong");

    // The journal reaches the audit log (syncJournal every 30 seconds).
    await waitFor(
      "the journal in audit_log",
      async () => {
        const rows = await project.compose([
          "exec",
          "-T",
          "db",
          "psql",
          "-U",
          "notes",
          "-d",
          "notes",
          "-At",
          "-c",
          "SELECT string_agg(action, ',' ORDER BY created_at) FROM audit_log",
        ]);
        const actions = rows.stdout.trim();
        return actions.includes("update.succeeded") ? actions : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 5000 },
    );

    // Acknowledge through the admin endpoint.
    const acked = await project.http(
      "api",
      `http://api:3000/api/admin/updates/${run.id}/acknowledge`,
      adminToken,
      { method: "POST", body: {} },
    );
    expect(acked.status).toBe(200);

    // While the api is down, the Caddy edge serves the sidecar's maintenance page.
    await project.compose(["stop", "api"]);
    // handle_errors answers with the page itself (status 200, Cache-Control: no-store).
    const page = await edge("http://127.0.0.1:8080/api/ping");
    expect(page.body).toContain("/public/v1/maintenance/");
    const status = await edge("http://127.0.0.1:8080/public/v1/status");
    expect(JSON.parse(status.body.slice(status.body.indexOf("{"))).phase).toBe("idle");
    await project.compose(["start", "api"]);
  });
});

describe("python-postgres", () => {
  it("installs and updates (Alembic at start, key mode, encrypted backup)", async () => {
    const identity = await sh(
      "mkdir -p /srv/e2e/age-py && docker run --rm -v /srv/e2e/age-py:/k --entrypoint age-keygen cicd-updater:e2e-ca -o /k/identity.txt 2>&1 | grep -o 'age1[0-9a-z]*'",
    );
    const example = await Example.create({
      name: "python-postgres",
      project: "fastnotes",
      images: { app: { variable: "APP_IMAGE", file: "app/Dockerfile" } },
      env: {
        POSTGRES_PASSWORD: "fastnotes-db-password-e2e",
        ADMIN_TOKEN: "e2e-admin-token-abcdef0123456789",
      },
      // README step: the registry login for pulls (the test registry needs none).
      files: { "registry-auth.json": '{"auths": {}}\n' },
      updater: (config) => {
        const backup = (config.hooks as Record<string, Record<string, unknown>>).backup as Record<
          string,
          unknown
        >;
        backup.encryption = { ageRecipients: [identity.stdout.trim()] };
      },
    });
    await example.release("1.0.0");
    await example.release("1.1.0");
    const project = await example.install("1.0.0");
    current = project;
    expect((await project.state()).running.version).toBe("1.0.0");
    const run = await project.update("1.1.0");
    expect(run.failure).toBeNull();
    expect(run.outcome).toBe("succeeded");
    const backups = JSON.parse((await project.cli(["backups", "list", "--json"])).stdout) as {
      file: string;
    }[];
    expect(backups[0]?.file).toMatch(/\.pgdump\.age$/);
    // nginx: error_page with the named location serves the maintenance page while the api is down.
    await project.compose(["stop", "api"]);
    const page = await edge("http://127.0.0.1:8080/");
    expect(page.body).toContain("/public/v1/maintenance/");
    await project.compose(["start", "api"]);
    await project.ack();
    await sh("rm -rf /srv/e2e/age-py");
  });
});

describe("static-site", () => {
  it("installs and updates (no backup, rollback always, version.json)", async () => {
    const example = await Example.create({
      name: "static-site",
      project: "handbook",
      images: { web: { variable: "WEB_IMAGE", file: "Dockerfile" } },
    });
    await example.release("1.0.0");
    await example.release("1.1.0");
    const project = await example.install("1.0.0");
    current = project;
    expect(
      JSON.parse((await edge("http://127.0.0.1:8080/version.json")).body.replace(/^[^{]*/, ""))
        .version,
    ).toBe("1.0.0");
    const run = await project.update("1.1.0");
    expect(run.outcome).toBe("succeeded");
    expect(run.steps.find((step) => step.id === "backup")?.status).toBe("skipped");
    expect((await edge("http://127.0.0.1:8080/")).body).toContain("Acme Handbook");
    await project.ack();
  });
});
