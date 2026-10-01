import { q } from "./exec.js";
import { IMAGES, KEYS, REGISTRY, sh, UPDATER, WORK } from "./host.js";
import { Project, sidecarService } from "./project.js";
import { imageRef, type PublishedImage, publishRelease, type Release } from "./release.js";

/**
 * The stub app (e2e/stub) in a Compose project: api and worker from the image "app",
 * an optional edge from the image "edge", PostgreSQL, and the sidecar. Each version's
 * behaviour is fixed by build arguments (see e2e/stub/Dockerfile).
 */

export interface StubVersion {
  version: string;
  health?: "ok" | "unready" | "crash" | "wrong-version";
  /** The migration this version applies (a number), applied at start or by the migrate hook. */
  migration?: number;
  migrateFail?: boolean;
  migrateOnStart?: boolean;
  /** MiB of random data in an extra layer, so pulling the image takes a while. */
  padMiB?: number;
}

export interface StubOptions {
  name: string;
  trust?: "key" | "none";
  /** Services and hooks; defaults: api + worker + db, postgres backup and probe. */
  edge?: boolean;
  edgeOptional?: boolean;
  backup?: Record<string, unknown>;
  migrateHook?: boolean;
  healthTimeoutSeconds?: number;
  rollback?: "probe" | "always" | "never";
  updater?: (config: Record<string, unknown>) => void;
  compose?: (compose: {
    services: Record<string, Record<string, unknown>>;
    volumes: Record<string, unknown>;
  }) => void;
  registry?: string;
}

const PROBE_QUERY =
  "SELECT coalesce((SELECT string_agg(version, ',' ORDER BY version) FROM stub_migrations), 'none')";

export class StubApp {
  readonly root: string;
  readonly releases = new Map<string, Release>();

  private constructor(
    readonly project: Project,
    readonly options: StubOptions,
  ) {
    this.root = `${WORK}/build/${options.name}`;
  }

  get repository(): { app: string; edge: string } {
    const registry = this.options.registry ?? REGISTRY;
    return {
      app: `${registry}/e2e/${this.options.name}-app`,
      edge: `${registry}/e2e/${this.options.name}-edge`,
    };
  }

  /** Create the project directory (not started) and the build root. */
  static async create(options: StubOptions): Promise<StubApp> {
    const project = new Project(options.name);
    const app = new StubApp(project, options);
    await sh(
      `rm -rf ${q(app.root)} ${q(project.dir)} && mkdir -p ${q(app.root)} && cp -R /repo/e2e/stub/. ${q(app.root)}/`,
    );
    return app;
  }

  buildArgs(version: StubVersion): Record<string, string> {
    return {
      STUB_HEALTH: version.health ?? "ok",
      STUB_MIGRATION: version.migration === undefined ? "none" : String(version.migration),
      STUB_MIGRATE_FAIL: version.migrateFail ? "1" : "0",
      STUB_MIGRATE_ON_START: version.migrateOnStart ? "1" : "0",
      STUB_PAD_MB: String(version.padMiB ?? 0),
    };
  }

  /** Build and publish a version into the project's feed. */
  async release(
    version: StubVersion,
    extra: Partial<Parameters<typeof publishRelease>[0]> & { withEdge?: boolean } = {},
  ): Promise<Release> {
    const images: Record<
      string,
      { repository: string; context: string; buildArgs: Record<string, string>; file?: string }
    > = {
      app: { repository: this.repository.app, context: ".", buildArgs: this.buildArgs(version) },
    };
    if (extra.withEdge ?? this.options.edge) {
      images.edge = {
        repository: this.repository.edge,
        context: ".",
        buildArgs: { ...this.buildArgs(version), STUB_ROLE: "edge" },
      };
    }
    const release = await publishRelease({
      root: this.root,
      feed: this.project.feed,
      version: version.version,
      images,
      project: `local/e2e/${this.options.name}`,
      signing: this.options.trust ?? "key",
      ...extra,
    });
    this.releases.set(version.version, release);
    return release;
  }

  ref(version: string, key = "app"): string {
    const release = this.releases.get(version);
    const image = release?.images[key] as PublishedImage | undefined;
    if (!image) {
      throw new Error(`no image ${key} in release ${version}`);
    }
    return imageRef(image);
  }

  updaterConfig(): Record<string, unknown> {
    const o = this.options;
    const services: Record<string, unknown>[] = [
      { name: "api", image: "app", imageVar: "APP_IMAGE", startOrder: 1 },
      { name: "worker", image: "app", imageVar: "APP_IMAGE", startOrder: 2 },
    ];
    if (o.edge) {
      services.push({
        name: "edge",
        image: "edge",
        imageVar: "EDGE_IMAGE",
        startOrder: 3,
        optional: o.edgeOptional ?? false,
        stopBeforeUpdate: false,
      });
    }
    const config: Record<string, unknown> = {
      version: 1,
      compose: { profiles: ["updater"] },
      docker: { minFreeMb: 64 },
      release: { feed: { type: "file", path: this.project.feed }, cacheSeconds: 0 },
      trust:
        (o.trust ?? "key") === "key"
          ? { mode: "key", key: { publicKeyFiles: [`${this.project.dir}/keys/cosign.pub`] } }
          : { mode: "none", none: { acknowledgeUnsigned: true } },
      services,
      hooks: {
        backup: o.backup ?? { type: "postgres", service: "db" },
        migrationProbe: { type: "postgres", service: "db", query: PROBE_QUERY },
        ...(o.migrateHook
          ? { migrate: { service: "api", argv: ["node", "migrate.mjs"], timeoutSeconds: 60 } }
          : {}),
        health: {
          type: "http",
          http: { url: "http://api:3000/healthz", versionJsonPath: "$.version" },
          intervalSeconds: 1,
          timeoutSeconds: o.healthTimeoutSeconds ?? 45,
          servicesGraceSeconds: 20,
        },
        smoke: {
          checks: [{ type: "http", url: "http://api:3000/ping", bodyContains: "pong" }],
          intervalSeconds: 1,
        },
      },
      rollback: { policy: o.rollback ?? "probe" },
      schedule: { lateStartToleranceSeconds: 30 },
      logging: { level: "debug" },
    };
    o.updater?.(config);
    return config;
  }

  composeFile(): Record<string, unknown> {
    const o = this.options;
    const services: Record<string, Record<string, unknown>> = {
      api: {
        image: "${APP_IMAGE:?}",
        restart: "unless-stopped",
        environment: { DATABASE_URL: "postgres://stub:${POSTGRES_PASSWORD:?}@db:5432/stub" },
        depends_on: { db: { condition: "service_healthy" } },
      },
      worker: {
        image: "${APP_IMAGE:?}",
        command: ["node", "server.mjs", "worker"],
        restart: "unless-stopped",
        environment: { DATABASE_URL: "postgres://stub:${POSTGRES_PASSWORD:?}@db:5432/stub" },
      },
      db: {
        image: IMAGES.postgres,
        restart: "unless-stopped",
        environment: {
          POSTGRES_USER: "stub",
          POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?}",
          POSTGRES_DB: "stub",
        },
        volumes: ["db-data:/var/lib/postgresql/data"],
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U stub -d stub"],
          interval: "2s",
          timeout: "3s",
          retries: 30,
        },
      },
      updater: sidecarService(UPDATER),
    };
    if (o.edge) {
      services.edge = { image: "${EDGE_IMAGE:?}", restart: "unless-stopped" };
    }
    const compose = {
      services,
      volumes: { "db-data": {}, "updater-state": {}, "updater-shared": {}, "updater-verify": {} },
    };
    o.compose?.(compose);
    return compose;
  }

  /** Write the project for `version` (already released) and start it. */
  async install(version: string, env: Record<string, string> = {}): Promise<Project> {
    await sh(
      `mkdir -p ${q(this.project.dir)}/keys && cp ${KEYS}/main/cosign.pub ${q(this.project.dir)}/keys/cosign.pub`,
    );
    await this.project.writeCompose(this.composeFile());
    await this.project.writeUpdater(this.updaterConfig());
    await this.project.writeEnv({
      PROJECT_DIR: this.project.dir,
      APP_IMAGE: this.ref(version),
      ...(this.options.edge
        ? {
            EDGE_IMAGE: this.ref(version, this.releases.get(version)?.images.edge ? "edge" : "app"),
          }
        : {}),
      POSTGRES_PASSWORD: "stub-db-password-e2e",
      ...env,
    });
    await this.project.up();
    await this.project.ready();
    return this.project;
  }
}
