import { z } from "zod";
import { CHANNELS, TRUST_MODES } from "./codes.js";
import { DEFAULT_TAG_PATTERN, isValidTagPattern } from "./identity.js";
import { isValidJsonPath } from "./json-path.js";
import { IMAGE_KEY_PATTERN } from "./release.js";

/**
 * `updater.yaml`, the sidecar's configuration (design 4). The JSON Schema
 * `schemas/updater-config.schema.json` is generated from this definition and
 * `docs/configuration.md` is checked against it.
 *
 * Unknown keys are an error everywhere: a typo must not silently disable a
 * safety setting. Settings of inactive trust modes and hook types are errors
 * too, so a leftover block cannot mislead a reader.
 */

export const CONFIG_VERSION = 1;
export const DEFAULT_CONFIG_PATH = "/etc/cicd-updater/updater.yaml";
export const CONFIG_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** Absolute POSIX path without `..`, NUL, newline, `:` or `,` (design 4.3, type `path`). */
export function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    value.length <= 1024 &&
    !/[\0\n\r:,]/.test(value) &&
    !value.split("/").includes("..")
  );
}

/** Relative path inside the project directory (type `relpath`). */
export function isRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !/[\0\n\r]/.test(value) &&
    !value.split("/").includes("..")
  );
}

/** Absolute URL without credentials and fragment (type `url`); `https` only unless `http` is allowed. */
export function isPlainUrl(value: string, protocols: readonly string[] = ["https:"]): boolean {
  try {
    const url = new URL(value);
    return (
      protocols.includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      !value.includes("#") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

const absPath = z
  .string()
  .refine(isAbsolutePath, { message: "must be an absolute path without '..', ':' or ','" });
const relPath = z
  .string()
  .refine(isRelativePath, { message: "must be a relative path inside the project without '..'" });
const httpsUrl = z
  .string()
  .max(2000)
  .refine((value) => isPlainUrl(value), {
    message: "must be an https URL without credentials or fragment",
  });
const httpUrl = z
  .string()
  .max(2000)
  .refine((value) => isPlainUrl(value, ["http:", "https:"]), {
    message: "must be an http(s) URL without credentials or fragment",
  });

export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export const IMAGE_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
export const DB_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const DIGEST_PINNED_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[0-9a-f]{64}$/;
export const AGE_RECIPIENT_PATTERN = /^age1[02-9ac-hj-np-z]{58}$/;
export const BUILD_ARG_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const BUILD_ARG_VALUE_PATTERN = /^[0-9A-Za-z._{}-]{0,128}$/;
export const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LISTEN_PATTERN = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:]+)\]):(\d{1,5})$/;

function isListen(value: string): boolean {
  const match = LISTEN_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return false;
  }
  if (match[1]) {
    return match[1].split(".").every((octet) => Number(octet) <= 255);
  }
  return true;
}

function isRegex(value: string): boolean {
  try {
    new RegExp(value, "i");
    return true;
  } catch {
    return false;
  }
}

const argv = z
  .array(
    z
      .string()
      .max(4096)
      .refine((value) => !value.includes("\0"), { message: "must not contain NUL" }),
  )
  .min(1)
  .max(64)
  .meta({ description: "1 to 64 arguments, no shell." });

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const serviceName = z.string().regex(SERVICE_NAME_PATTERN);
const dbName = z.string().regex(DB_NAME_PATTERN);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const serverSchema = z
  .strictObject({
    listen: z
      .string()
      .refine(isListen, { message: "must be host:port with an IP literal host" })
      .default("0.0.0.0:8090")
      .meta({ description: "Address the HTTP API listens on inside the container." }),
    allowPublishedPort: z.boolean().default(false).meta({
      description:
        "false: a published host port on the sidecar container is the blocker api_exposed.",
    }),
  })
  .prefault({});

const authSchema = z
  .strictObject({
    tokenFile: absPath.nullable().default(null).meta({
      description:
        "Operator-provided token file (for example a Compose secret); null: the sidecar generates the token.",
    }),
    sharedDir: absPath
      .default("/shared")
      .meta({ description: "A generated token is written to <sharedDir>/token." }),
    tokenGroupId: int(0, 2147483647)
      .default(0)
      .meta({ description: "Group of the generated token file (mode 0640, owner root)." }),
  })
  .prefault({});

const stateSchema = z
  .strictObject({
    dir: absPath
      .default("/state")
      .meta({ description: "Holds status.json, backups/, releases/ and src/. Must be a volume." }),
    historyLimit: int(1, 100).default(20).meta({ description: "Finished runs kept in history." }),
    eventLimit: int(50, 5000).default(500).meta({ description: "Journal events kept." }),
  })
  .prefault({});

const selfSchema = z
  .strictObject({
    service: serviceName.nullable().default(null).meta({
      description:
        "The sidecar's own Compose service; null: its container label com.docker.compose.service.",
    }),
  })
  .prefault({});

const composeSchema = z.strictObject({
  projectDir: absPath.meta({
    description:
      "Host path of the Compose project, mounted at the same path inside the container. Required.",
  }),
  projectName: z
    .string()
    .regex(PROJECT_NAME_PATTERN)
    .nullable()
    .default(null)
    .meta({ description: "null: the sidecar's own label com.docker.compose.project." }),
  files: z
    .array(relPath)
    .max(10)
    .default([])
    .meta({ description: "Files passed as -f; empty: Compose's own discovery." }),
  envFile: relPath
    .default(".env")
    .meta({ description: "The interpolation env file Compose reads (the only file written)." }),
  profiles: z
    .array(z.string().regex(PROFILE_PATTERN))
    .max(16)
    .default([])
    .meta({ description: "Profiles passed as --profile to every Compose call." }),
});

const dockerSchema = z
  .strictObject({
    socket: absPath.default("/var/run/docker.sock").meta({ description: "Docker Engine socket." }),
    registryAuthFile: absPath.nullable().default(null).meta({
      description: "Docker config.json with an auths object only, used for pulls and verification.",
    }),
    minFreeMb: int(0, 100_000_000).default(2048).meta({
      description:
        "Free space required after the backup on the file system of the backups directory (state.dir/backups: the state volume, or a separate volume mounted there).",
    }),
  })
  .prefault({});

export const FEED_TYPES = ["github", "gitea", "gitlab", "static", "file"] as const;
export type FeedType = (typeof FEED_TYPES)[number];

const feedSchema = z.strictObject({
  type: z.enum(FEED_TYPES).meta({ description: "Feed provider." }),
  url: httpsUrl
    .nullable()
    .default(null)
    .meta({ description: "Repository URL, or the index URL for static; not used with file." }),
  path: absPath
    .nullable()
    .default(null)
    .meta({ description: "file only: directory with index.json, documents and bundles." }),
  tokenFile: absPath
    .nullable()
    .default(null)
    .meta({ description: "Token for a private repository, sent only to the feed origin." }),
  allowPrivateNetwork: z
    .boolean()
    .default(false)
    .meta({ description: "Allow loopback/private addresses for the feed host." }),
});

const releaseSchema = z.strictObject({
  feed: feedSchema,
  channel: z.enum(CHANNELS).default("stable").meta({ description: "stable or beta." }),
  tagPattern: z
    .string()
    .refine(isValidTagPattern, { message: "must contain {version} exactly once" })
    .default(DEFAULT_TAG_PATTERN)
    .meta({ description: "How a version maps to the Git tag." }),
  cacheSeconds: int(0, 86400).default(300).meta({ description: "Reuse of the release list." }),
  checkIntervalHours: int(0, 168)
    .default(0)
    .meta({ description: "0: the sidecar reads the feed only on request." }),
});

const keylessSchema = z.strictObject({
  github: z
    .strictObject({
      repository: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/)
        .meta({ description: "owner/repo of the release workflow." }),
      workflow: z
        .string()
        .regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/)
        .meta({ description: ".github/workflows/<file>.yml" }),
    })
    .optional(),
  gitlab: z
    .strictObject({
      host: z
        .string()
        .regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/)
        .default("gitlab.com")
        .meta({ description: "GitLab instance host (issuer https://<host>)." }),
      project: z
        .string()
        .regex(/^[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,100}){1,6}$/)
        .meta({ description: "group[/subgroup...]/project" }),
      ciConfigPath: relPath
        .default(".gitlab-ci.yml")
        .meta({ description: "Path of the CI configuration in the project." }),
    })
    .optional(),
  issuer: httpsUrl.optional().meta({ description: "Generic form: OIDC issuer." }),
  identityTemplate: z
    .string()
    .max(1024)
    .regex(/^[\x21-\x7e]+$/)
    .refine((value) => value.includes("{tag}"), { message: "must contain {tag}" })
    .optional()
    .meta({ description: "Generic form: exact identity with {tag} and optional {version}." }),
  trustedRootFile: absPath
    .nullable()
    .default(null)
    .meta({ description: "Sigstore trusted root JSON for air-gapped hosts." }),
});

const keySchema = z.strictObject({
  publicKeyFiles: z
    .array(absPath)
    .min(1)
    .max(5)
    .meta({ description: "PEM public keys; a signature by any of them is accepted." }),
  transparencyLog: z
    .boolean()
    .default(false)
    .meta({ description: "true: signatures must also have a transparency log entry." }),
});

const trustSchema = z
  .strictObject({
    mode: z
      .enum(TRUST_MODES)
      .default("keyless")
      .meta({ description: "keyless, key or none; never a fallback between them." }),
    keyless: keylessSchema.optional(),
    key: keySchema.optional(),
    none: z
      .strictObject({
        acknowledgeUnsigned: z
          .boolean()
          .default(false)
          .meta({ description: "Must be true with mode none." }),
      })
      .optional(),
    verifier: z
      .strictObject({
        isolate: z
          .boolean()
          .default(true)
          .meta({ description: "Run cosign in an isolated sibling container." }),
        workDir: absPath
          .default("/verify")
          .meta({ description: "Volume shared read-only with the verifier." }),
        timeoutSeconds: int(10, 1800).default(300).meta({ description: "Per cosign call." }),
      })
      .prefault({}),
  })
  .prefault({});

const imageOverrideSchema = z.strictObject({
  repository: z
    .string()
    .max(255)
    .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+$/)
    .meta({ description: "Mirror repository; signatures must have been copied (cosign copy)." }),
});

export const httpCheckSchema = z.strictObject({
  type: z.literal("http").meta({ description: "An HTTP GET." }),
  url: httpUrl.meta({ description: "http(s) URL on the internal network." }),
  expectStatus: z
    .array(int(100, 599))
    .min(1)
    .max(20)
    .default([200])
    .meta({ description: "Accepted statuses." }),
  bodyContains: z
    .string()
    .min(1)
    .max(1000)
    .nullable()
    .default(null)
    .meta({ description: "Text the body must contain." }),
  sendToken: z
    .boolean()
    .default(false)
    .meta({ description: "Send Authorization: Bearer <token>." }),
});

export const commandCheckSchema = z.strictObject({
  type: z.literal("command").meta({ description: "A command in a service container." }),
  service: serviceName.meta({ description: "Runs with docker compose exec -T in this service." }),
  argv,
  expectExitCode: int(0, 255).default(0).meta({ description: "Expected exit code." }),
});

export const checkSchema = z.discriminatedUnion("type", [httpCheckSchema, commandCheckSchema]);
export type CheckSpec = z.infer<typeof checkSchema>;

const serviceSchema = z.strictObject({
  name: serviceName.meta({ description: "Compose service name." }),
  image: z.string().regex(IMAGE_KEY_PATTERN).meta({ description: "Key in release.json images." }),
  imageVar: z
    .string()
    .regex(IMAGE_VAR_PATTERN)
    .meta({ description: "Env key the service takes its image from (a writable key)." }),
  startOrder: int(1, 9).default(1).meta({ description: "Start group, ascending." }),
  stopBeforeUpdate: z
    .boolean()
    .default(true)
    .meta({ description: "Stopped in the stop step (writers such as workers)." }),
  stopOnAttention: z
    .boolean()
    .default(true)
    .meta({ description: "Stopped when the run ends in needs_attention." }),
  optional: z
    .boolean()
    .default(false)
    .meta({ description: "A release without this image key leaves the service as it is." }),
  health: checkSchema.nullable().default(null).meta({ description: "Extra per-service check." }),
});
export type ServiceConfig = z.infer<typeof serviceSchema>;

const envSchema = z
  .strictObject({
    versionVar: z
      .string()
      .regex(IMAGE_VAR_PATTERN)
      .nullable()
      .default(null)
      .meta({ description: "Env key that receives the plain target version (a writable key)." }),
    redactKeyPattern: z
      .string()
      .max(500)
      .refine(isRegex, { message: "must be a valid regular expression" })
      .default("(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|DSN)")
      .meta({ description: "Values of matching env keys are registered for redaction." }),
  })
  .prefault({});

export const BACKUP_TYPES = ["none", "postgres", "mysql", "volume", "command"] as const;
export type BackupType = (typeof BACKUP_TYPES)[number];

const backupSchema = z
  .strictObject({
    type: z
      .enum(BACKUP_TYPES)
      .default("none")
      .meta({ description: "Backup taken before the update." }),
    service: serviceName.optional().meta({ description: "Database service (postgres, mysql)." }),
    user: dbName
      .nullable()
      .default(null)
      .meta({ description: "null: the container's own env (POSTGRES_USER; MySQL: root)." }),
    database: dbName
      .nullable()
      .default(null)
      .meta({ description: "null: POSTGRES_DB / MYSQL_DATABASE / MARIADB_DATABASE." }),
    flavor: z
      .enum(["auto", "mysql", "mariadb"])
      .default("auto")
      .meta({ description: "MySQL family; auto: mariadb-dump if present, else mysqldump." }),
    volumes: z
      .array(z.string().regex(SERVICE_NAME_PATTERN))
      .max(16)
      .default([])
      .meta({ description: "volume: Compose volume names (project prefix resolved)." }),
    quiesce: z
      .boolean()
      .default(false)
      .meta({ description: "Stop before the backup (forced true for volume)." }),
    command: z
      .strictObject({
        image: z
          .string()
          .regex(DIGEST_PINNED_IMAGE_PATTERN)
          .meta({ description: "Image pinned by digest." }),
        argv,
        envKeys: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))
          .max(32)
          .default([])
          .meta({ description: "Env keys whose values are passed to the backup container." }),
        network: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
          .default("project")
          .meta({
            description:
              "project: the project's default network; none; or the key of a network in the Compose file (where the database is).",
          }),
        outputFile: z
          .string()
          .regex(FILE_NAME_PATTERN)
          .default("backup.out")
          .meta({ description: "File the container writes into /backup." }),
      })
      .optional(),
    lockWaitSeconds: int(1, 3600)
      .default(120)
      .meta({ description: "PostgreSQL --lock-wait-timeout." }),
    encryption: z
      .strictObject({
        ageRecipients: z
          .array(z.string().regex(AGE_RECIPIENT_PATTERN))
          .max(16)
          .default([])
          .meta({ description: "age1... public keys; the verified backup is encrypted." }),
      })
      .prefault({}),
    retention: z
      .strictObject({
        keep: int(1, 50).default(3).meta({ description: "Newest backups kept." }),
        maxAgeDays: int(0, 3650)
          .default(14)
          .meta({ description: "Older backups are deleted; 0: no age limit." }),
      })
      .prefault({}),
    timeoutSeconds: int(60, 86400).default(7200).meta({ description: "For creating the backup." }),
    verifyTimeoutSeconds: int(60, 86400)
      .default(1800)
      .meta({ description: "For verifying the backup." }),
  })
  .prefault({});

export const PROBE_PRESETS = [
  "drizzle",
  "prisma",
  "knex",
  "alembic",
  "django",
  "flyway",
  "rails",
  "golang-migrate",
  "node-pg-migrate",
  "typeorm",
  "sequelize",
] as const;
export type ProbePreset = (typeof PROBE_PRESETS)[number];

export const PROBE_TYPES = ["none", "postgres", "mysql", "command", "http"] as const;

const probeSchema = z
  .strictObject({
    type: z
      .enum(PROBE_TYPES)
      .default("none")
      .meta({ description: "How the schema state is read before and after the update." }),
    service: serviceName.optional().meta({ description: "Database service (postgres, mysql)." }),
    user: dbName.nullable().default(null).meta({ description: "As in hooks.backup." }),
    database: dbName.nullable().default(null).meta({ description: "As in hooks.backup." }),
    preset: z
      .enum(PROBE_PRESETS)
      .nullable()
      .default(null)
      .meta({ description: "Query of a migration tool (docs/hooks.md); exclusive with query." }),
    query: z
      .string()
      .max(4000)
      .nullable()
      .default(null)
      .meta({ description: "One SELECT returning one value; exclusive with preset." }),
    fingerprint: z
      .boolean()
      .default(true)
      .meta({ description: "Append a hash of the schema catalog (columns) to the value." }),
    command: z
      .strictObject({
        service: serviceName.meta({ description: "Runs with docker compose exec -T." }),
        argv,
      })
      .optional(),
    http: z
      .strictObject({
        url: httpUrl.meta({ description: "GET with the token." }),
        jsonPath: z
          .string()
          .refine(isValidJsonPath, { message: "must be a path like $.a.b[0]" })
          .meta({ description: "Path of the value in the JSON body." }),
      })
      .optional(),
    timeoutSeconds: int(1, 600).default(60).meta({ description: "Per probe." }),
  })
  .prefault({});

const migrateSchema = z.strictObject({
  service: serviceName.meta({ description: "A managed service whose new image runs the command." }),
  argv,
  timeoutSeconds: int(10, 86400).default(1800).meta({ description: "For the migration run." }),
});

const conditionSchema = z.strictObject({
  path: z
    .string()
    .refine(isValidJsonPath, { message: "must be a path like $.a.b[0]" })
    .meta({ description: "Path in the JSON body." }),
  equals: z
    .union([z.string().max(1000), z.number(), z.boolean(), z.null()])
    .meta({ description: "Value the path must hold." }),
});

const healthSchema = z
  .strictObject({
    type: z
      .enum(["none", "http", "command"])
      .default("none")
      .meta({ description: "The app check; none gives the warning health_without_app_check." }),
    http: z
      .strictObject({
        url: httpUrl.meta({ description: "http(s) URL on the internal network." }),
        sendToken: z.boolean().default(true).meta({
          description: "Send Authorization: Bearer <token> (the app may reveal its version).",
        }),
        expectStatus: z
          .array(int(100, 599))
          .min(1)
          .max(20)
          .default([200])
          .meta({ description: "Accepted statuses." }),
        versionJsonPath: z
          .string()
          .refine(isValidJsonPath, { message: "must be a path like $.version" })
          .nullable()
          .default(null)
          .meta({ description: "Path of the version in the JSON body; null: no version check." }),
        conditions: z
          .array(conditionSchema)
          .max(20)
          .default([])
          .meta({ description: "{ path, equals } pairs that must hold in the body." }),
        requestTimeoutSeconds: int(1, 60).default(5).meta({ description: "Per request." }),
      })
      .optional(),
    command: z
      .strictObject({
        service: serviceName.meta({
          description: "Runs with docker compose exec -T; exit 0 is healthy.",
        }),
        argv,
        versionFromStdout: z
          .boolean()
          .default(false)
          .meta({ description: "The first line of stdout is the version." }),
      })
      .optional(),
    afterGroup: int(1, 9)
      .nullable()
      .default(null)
      .meta({ description: "Start group after which the app check runs first; null: the lowest." }),
    intervalSeconds: int(1, 60).default(2).meta({ description: "Between polls." }),
    timeoutSeconds: int(10, 7200).default(600).meta({ description: "Per wait." }),
    versionMismatchLimit: int(1, 20).default(3).meta({
      description: "Healthy answers with another version before health.version_mismatch.",
    }),
    crashLimit: int(1, 10)
      .default(2)
      .meta({ description: "Restarting/exited observations before health.crashed." }),
    waitForDockerHealth: z
      .enum(["auto", "always", "never"])
      .default("auto")
      .meta({ description: "auto: wait for healthy where a Docker healthcheck exists." }),
    servicesGraceSeconds: int(5, 600)
      .default(60)
      .meta({ description: "For all managed services to be running after the last group." }),
  })
  .prefault({});

const smokeSchema = z
  .strictObject({
    checks: z
      .array(checkSchema)
      .max(20)
      .default([])
      .meta({ description: "http or command checks after the app is healthy." }),
    retries: int(1, 20).default(5).meta({ description: "Attempts per check." }),
    intervalSeconds: int(1, 60).default(3).meta({ description: "Between attempts." }),
    timeoutSeconds: int(10, 1800).default(300).meta({ description: "For all checks." }),
  })
  .prefault({});

const hooksSchema = z
  .strictObject({
    backup: backupSchema,
    migrationProbe: probeSchema,
    migrate: migrateSchema
      .nullable()
      .default(null)
      .meta({ description: "Optional separate migration run before the services start." }),
    health: healthSchema,
    smoke: smokeSchema,
  })
  .prefault({});

const rollbackSchema = z
  .strictObject({
    policy: z
      .enum(["probe", "always", "never"])
      .nullable()
      .default(null)
      .meta({ description: "null: probe when a migration probe is configured, else never." }),
  })
  .prefault({});

const SOURCE_ALLOW_ENTRY =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?(\/[a-z0-9_.-]{1,100}){0,7}$/;

const sourceSchema = z
  .strictObject({
    allowlist: z
      .array(
        z
          .string()
          .regex(SOURCE_ALLOW_ENTRY)
          .refine((value) => value.split("/").length !== 2, {
            message: "must be a host or host/owner/repo",
          }),
      )
      .max(100)
      .default([])
      .meta({ description: "host or host/owner/repo, lowercase; empty: source mode off." }),
    tokenFile: absPath
      .nullable()
      .default(null)
      .meta({ description: "Token for the archive download; null: release.feed.tokenFile." }),
    maxArchiveMb: int(1, 2048).default(200).meta({ description: "Largest source archive." }),
    build: z
      .record(
        z.string().regex(IMAGE_KEY_PATTERN),
        z.strictObject({
          context: relPath.default(".").meta({ description: "Build context inside the archive." }),
          dockerfile: relPath.default("Dockerfile").meta({ description: "Dockerfile path." }),
          target: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
            .nullable()
            .default(null)
            .meta({ description: "Dockerfile target." }),
          buildArgs: z
            .record(
              z.string().regex(BUILD_ARG_NAME_PATTERN),
              z.string().regex(BUILD_ARG_VALUE_PATTERN),
            )
            .default({})
            .meta({ description: "Build arguments; {version} is replaced." }),
        }),
      )
      .default({})
      .meta({ description: "How each image key is built in source mode." }),
  })
  .prefault({});

const cleanupSchema = z
  .strictObject({
    keepPreviousImages: int(0, 10).default(1).meta({
      description: "Older images per repository kept besides the current and rollback image.",
    }),
  })
  .prefault({});

const scheduleSchema = z
  .strictObject({
    maxLeadSeconds: int(0, 2_592_000)
      .default(1_209_600)
      .meta({ description: "Latest start a request may ask for." }),
    lateStartToleranceSeconds: int(0, 86400)
      .default(600)
      .meta({ description: "A run found later than this after startsAt is not started." }),
  })
  .prefault({});

const timeoutsSchema = z
  .strictObject({
    pullSeconds: int(60, 14400).default(1800).meta({ description: "Per image pull." }),
    stopSeconds: int(1, 600).default(60).meta({ description: "compose stop -t." }),
    upSeconds: int(30, 3600).default(900).meta({ description: "Per compose up." }),
    composeSeconds: int(10, 600)
      .default(120)
      .meta({ description: "For config, ps, logs and inspect calls." }),
  })
  .prefault({});

const publicStatusSchema = z
  .strictObject({
    enabled: z.boolean().default(true).meta({ description: "Serve GET /public/v1/status." }),
    showVersions: z
      .boolean()
      .default(false)
      .meta({ description: "Include versions in the public status." }),
  })
  .prefault({});

const maintenancePageSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(false)
      .meta({ description: "Serve the page under /public/v1/maintenance/." }),
    brandingFile: absPath
      .nullable()
      .default(null)
      .meta({ description: "JSON { productName, logoFile, accentColor, supportUrl }." }),
    templateDir: absPath
      .nullable()
      .default(null)
      .meta({ description: "Replaces the built-in index.html and maintenance.css." }),
    languages: z
      .array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/))
      .min(1)
      .max(20)
      .default(["en", "de"])
      .meta({ description: "Built-in: en, de; others need templateDir catalogs." }),
  })
  .prefault({});

const loggingSchema = z
  .strictObject({
    level: z
      .enum(["debug", "info", "warn", "error"])
      .default("info")
      .meta({ description: "Log level." }),
    format: z
      .enum(["text", "json"])
      .default("text")
      .meta({ description: "json: one object per line." }),
    redactPatterns: z
      .array(z.string().max(500).refine(isRegex, { message: "must be a valid regular expression" }))
      .max(32)
      .default([])
      .meta({ description: "Extra regular expressions whose matches are replaced by [redacted]." }),
  })
  .prefault({});

const selfCheckSchema = z
  .strictObject({
    enabled: z.boolean().default(false).meta({
      description: "Report a newer sidecar release in GET /v1/state (never installs it).",
    }),
  })
  .prefault({});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const PROBE_QUERY = /^\s*select\b[^;]*;?\s*$/is;

/** Presets without a query for one database family. */
const PRESET_UNSUPPORTED: Readonly<Record<string, readonly ProbePreset[]>> = {
  mysql: ["node-pg-migrate"],
  postgres: [],
};

export const configObjectSchema = z
  .strictObject({
    version: z.literal(CONFIG_VERSION).meta({ description: "Must be 1." }),
    server: serverSchema,
    auth: authSchema,
    state: stateSchema,
    self: selfSchema,
    compose: composeSchema,
    docker: dockerSchema,
    release: releaseSchema,
    trust: trustSchema,
    images: z
      .record(z.string().regex(IMAGE_KEY_PATTERN), imageOverrideSchema)
      .default({})
      .meta({ description: "Optional mirror per image key of release.json." }),
    services: z
      .array(serviceSchema)
      .min(1)
      .max(32)
      .meta({ description: "The managed Compose services." }),
    env: envSchema,
    hooks: hooksSchema,
    rollback: rollbackSchema,
    source: sourceSchema,
    cleanup: cleanupSchema,
    schedule: scheduleSchema,
    timeouts: timeoutsSchema,
    publicStatus: publicStatusSchema,
    maintenancePage: maintenancePageSchema,
    logging: loggingSchema,
    selfCheck: selfCheckSchema,
  })
  .meta({ title: "cicd-updater configuration (updater.yaml)" });

type RawConfig = z.output<typeof configObjectSchema>;

function crossFieldRules(config: RawConfig, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message });
  };

  // release.feed
  const feed = config.release.feed;
  if (feed.type === "file") {
    if (feed.path === null) {
      issue(["release", "feed", "path"], "is required with feed type file");
    }
    if (feed.url !== null) {
      issue(["release", "feed", "url"], "is not used with feed type file; remove it");
    }
  } else {
    if (feed.url === null) {
      issue(["release", "feed", "url"], `is required with feed type ${feed.type}`);
    } else {
      const problem = feedUrlProblem(feed.type, feed.url);
      if (problem) {
        issue(["release", "feed", "url"], problem);
      }
    }
    if (feed.path !== null) {
      issue(["release", "feed", "path"], "is used only with feed type file; remove it");
    }
  }

  // trust
  const trust = config.trust;
  if (trust.mode === "keyless") {
    const keyless = trust.keyless;
    const forms = [
      keyless?.github ? "github" : null,
      keyless?.gitlab ? "gitlab" : null,
      keyless?.issuer || keyless?.identityTemplate ? "generic" : null,
    ].filter(Boolean);
    if (forms.length === 0) {
      issue(
        ["trust", "keyless"],
        "keyless mode needs exactly one of github, gitlab or issuer + identityTemplate (docs/trust-modes.md)",
      );
    } else if (forms.length > 1) {
      issue(["trust", "keyless"], `set exactly one identity form, found ${forms.join(" and ")}`);
    } else if (forms[0] === "generic" && !(keyless?.issuer && keyless.identityTemplate)) {
      issue(["trust", "keyless"], "the generic form needs both issuer and identityTemplate");
    }
  } else if (trust.keyless !== undefined) {
    issue(["trust", "keyless"], `is a setting of keyless mode; the mode is ${trust.mode}`);
  }
  if (trust.mode === "key") {
    if (!trust.key) {
      issue(["trust", "key", "publicKeyFiles"], "key mode needs 1 to 5 public key files");
    }
  } else if (trust.key !== undefined) {
    issue(["trust", "key"], `is a setting of key mode; the mode is ${trust.mode}`);
  }
  if (trust.mode === "none") {
    if (trust.none?.acknowledgeUnsigned !== true) {
      issue(
        ["trust", "none", "acknowledgeUnsigned"],
        "must be true with mode none: signatures are then not checked (docs/trust-modes.md)",
      );
    }
  } else if (trust.none !== undefined) {
    issue(["trust", "none"], `is a setting of none mode; the mode is ${trust.mode}`);
  }

  // services
  const names = new Set<string>();
  const imageOfVar = new Map<string, string>();
  config.services.forEach((service, index) => {
    if (names.has(service.name)) {
      issue(["services", index, "name"], `service ${service.name} is listed twice`);
    }
    names.add(service.name);
    if (config.self.service !== null && service.name === config.self.service) {
      issue(["services", index, "name"], "the sidecar's own service cannot be managed");
    }
    const shared = imageOfVar.get(service.imageVar);
    if (shared !== undefined && shared !== service.image) {
      issue(
        ["services", index, "imageVar"],
        `${service.imageVar} is shared with a service of image ${shared}; services share a key only with the same image`,
      );
    }
    imageOfVar.set(service.imageVar, service.image);
  });
  if (config.env.versionVar !== null && imageOfVar.has(config.env.versionVar)) {
    issue(["env", "versionVar"], "must differ from every services[].imageVar");
  }
  const groups = new Set(config.services.map((service) => service.startOrder));

  // hooks.backup
  const backup = config.hooks.backup;
  const dbBackup = backup.type === "postgres" || backup.type === "mysql";
  if (dbBackup && !backup.service) {
    issue(["hooks", "backup", "service"], `is required with backup type ${backup.type}`);
  }
  if (!dbBackup) {
    if (backup.service !== undefined) {
      issue(["hooks", "backup", "service"], `is not used with backup type ${backup.type}`);
    }
    if (backup.user !== null || backup.database !== null) {
      issue(["hooks", "backup"], `user and database are not used with backup type ${backup.type}`);
    }
  }
  if (backup.type !== "mysql" && backup.flavor !== "auto") {
    issue(["hooks", "backup", "flavor"], "is used only with backup type mysql");
  }
  if (backup.type === "volume") {
    if (backup.volumes.length === 0) {
      issue(["hooks", "backup", "volumes"], "lists 1 to 16 volumes with backup type volume");
    }
  } else if (backup.volumes.length > 0) {
    issue(["hooks", "backup", "volumes"], "is used only with backup type volume");
  }
  if (backup.type === "command") {
    if (!backup.command) {
      issue(["hooks", "backup", "command"], "is required with backup type command");
    }
  } else if (backup.command !== undefined) {
    issue(["hooks", "backup", "command"], "is used only with backup type command");
  }
  if (backup.type === "none" && backup.encryption.ageRecipients.length > 0) {
    issue(["hooks", "backup", "encryption"], "is not used without a backup");
  }

  // hooks.migrationProbe
  const probe = config.hooks.migrationProbe;
  const dbProbe = probe.type === "postgres" || probe.type === "mysql";
  if (dbProbe) {
    if (!probe.service) {
      issue(["hooks", "migrationProbe", "service"], `is required with probe type ${probe.type}`);
    }
    if ((probe.preset === null) === (probe.query === null)) {
      issue(["hooks", "migrationProbe"], "set exactly one of preset or query");
    }
    if (probe.query !== null && !PROBE_QUERY.test(probe.query)) {
      issue(["hooks", "migrationProbe", "query"], "must be one SELECT statement");
    }
    if (probe.preset !== null && (PRESET_UNSUPPORTED[probe.type] ?? []).includes(probe.preset)) {
      issue(
        ["hooks", "migrationProbe", "preset"],
        `preset ${probe.preset} has no ${probe.type} query`,
      );
    }
  } else {
    if (probe.service !== undefined) {
      issue(["hooks", "migrationProbe", "service"], `is not used with probe type ${probe.type}`);
    }
    if (probe.preset !== null || probe.query !== null) {
      issue(
        ["hooks", "migrationProbe"],
        `preset and query are not used with probe type ${probe.type}`,
      );
    }
    if (probe.user !== null || probe.database !== null) {
      issue(
        ["hooks", "migrationProbe"],
        `user and database are not used with probe type ${probe.type}`,
      );
    }
  }
  if (probe.type === "command" ? !probe.command : probe.command !== undefined) {
    issue(
      ["hooks", "migrationProbe", "command"],
      probe.type === "command"
        ? "is required with probe type command"
        : "is used only with probe type command",
    );
  }
  if (probe.type === "http" ? !probe.http : probe.http !== undefined) {
    issue(
      ["hooks", "migrationProbe", "http"],
      probe.type === "http"
        ? "is required with probe type http"
        : "is used only with probe type http",
    );
  }

  // hooks.migrate
  const migrate = config.hooks.migrate;
  if (migrate !== null && !names.has(migrate.service)) {
    issue(["hooks", "migrate", "service"], "must be one of the managed services");
  }

  // hooks.health
  const health = config.hooks.health;
  if (health.type === "http" ? !health.http : health.http !== undefined) {
    issue(
      ["hooks", "health", "http"],
      health.type === "http"
        ? "is required with health type http"
        : "is used only with health type http",
    );
  }
  if (health.type === "command" ? !health.command : health.command !== undefined) {
    issue(
      ["hooks", "health", "command"],
      health.type === "command"
        ? "is required with health type command"
        : "is used only with health type command",
    );
  }
  if (health.afterGroup !== null && !groups.has(health.afterGroup)) {
    issue(["hooks", "health", "afterGroup"], "must be the startOrder of a managed service");
  }

  // rollback
  if (config.rollback.policy === "probe" && probe.type === "none") {
    issue(["rollback", "policy"], "probe needs hooks.migrationProbe");
  }

  // source
  for (const key of Object.keys(config.source.build)) {
    if (!config.services.some((service) => service.image === key)) {
      issue(["source", "build", key], "is not the image of a managed service");
    }
  }

  // maintenance page
  const languages = config.maintenancePage.languages;
  if (
    config.maintenancePage.templateDir === null &&
    languages.some((language) => language !== "en" && language !== "de")
  ) {
    issue(["maintenancePage", "languages"], "languages other than en and de need templateDir");
  }
}

/** Validation rules of the feed URL per provider (design 4.3). */
export function feedUrlProblem(type: FeedType, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.search !== "" && type !== "static") {
    return "must not have a query string";
  }
  switch (type) {
    case "github":
      if (url.hostname !== "github.com" || segments.length !== 2) {
        return "must be https://github.com/<owner>/<repo>";
      }
      return null;
    case "gitea":
      return segments.length >= 2 ? null : "must be https://<host>[/<prefix>]/<owner>/<repo>";
    case "gitlab":
      return segments.length >= 2 && segments.length <= 8
        ? null
        : "must be https://<host>/<group>[/<subgroup>...]/<project>";
    case "static":
      return null;
    case "file":
      return "is not used with feed type file";
  }
}

function derivedDefaults(config: RawConfig) {
  const policy =
    config.rollback.policy ?? (config.hooks.migrationProbe.type === "none" ? "never" : "probe");
  const backup =
    config.hooks.backup.type === "volume"
      ? { ...config.hooks.backup, quiesce: true }
      : config.hooks.backup;
  return {
    ...config,
    hooks: { ...config.hooks, backup },
    rollback: { policy },
  };
}

/** The complete schema: structure, cross-field rules, derived defaults. */
export const configSchema = configObjectSchema
  .superRefine(crossFieldRules)
  .transform(derivedDefaults);

/** The effective configuration after defaults (what the sidecar runs with). */
export type UpdaterConfig = z.output<typeof configSchema>;
/** What `updater.yaml` may contain. */
export type UpdaterConfigInput = z.input<typeof configObjectSchema>;

export interface ConfigProblem {
  /** Dotted key path (`services.0.imageVar`), or `(root)`. */
  path: string;
  message: string;
}

export type ConfigResult =
  | { ok: true; config: UpdaterConfig }
  | { ok: false; problems: ConfigProblem[] };

/** Validate a parsed document; all problems are collected, one per path and reason. */
export function validateConfig(input: unknown): ConfigResult {
  const result = configSchema.safeParse(input);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    const message = describeIssue(issue);
    const key = `${path}\0${message}`;
    if (!seen.has(key)) {
      seen.add(key);
      problems.push({ path, message });
    }
  }
  return { ok: false, problems };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unknown key${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}`;
  }
  return issue.message;
}

/** The keys the sidecar is allowed to rewrite in the env file: every imageVar plus versionVar. */
export function writableKeys(config: Pick<UpdaterConfig, "services" | "env">): string[] {
  const keys = new Set(config.services.map((service) => service.imageVar));
  if (config.env.versionVar) {
    keys.add(config.env.versionVar);
  }
  return [...keys];
}

/** Start groups in ascending order with their services. */
export function startGroups(
  config: Pick<UpdaterConfig, "services">,
): { group: number; services: ServiceConfig[] }[] {
  const groups = new Map<number, ServiceConfig[]>();
  for (const service of config.services) {
    const list = groups.get(service.startOrder) ?? [];
    list.push(service);
    groups.set(service.startOrder, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([group, services]) => ({ group, services }));
}

/** JSON with object keys sorted, for the configuration hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
