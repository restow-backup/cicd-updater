import { z } from "zod";
import {
  backupsViewSchema,
  capabilitiesSchema,
  configViewSchema,
  eventsViewSchema,
  healthViewSchema,
  problemSchema,
  publicStatusSchema,
  releasesViewSchema,
  rescheduleRequestSchema,
  runActionRequestSchema,
  runsViewSchema,
  scheduleRequestSchema,
  stateViewSchema,
  verificationResultSchema,
} from "./api.js";
import { API_VERSION, PROBLEM_STATUS } from "./codes.js";
import { configObjectSchema } from "./config.js";
import { feedIndexSchema } from "./feed-index.js";
import { releaseJsonSchema } from "./release-schema.js";
import { runSchema, statusFileSchema } from "./status.js";

/**
 * Generators for the committed JSON Schemas (`schemas/`) and the OpenAPI
 * document (`openapi/updater-api.v1.yaml`). Everything is derived from the zod
 * definitions of this package, except `release.schema.json`, which is
 * normative and hand-written. CI regenerates and fails on drift.
 */

const SCHEMA_BASE = "https://raw.githubusercontent.com/restow-backup/cicd-updater/main/schemas/";

type Json = Record<string, unknown>;

/** Remove noise zod emits that says nothing (safe-integer bounds) and inline nothing else. */
function clean(node: unknown, options: { openResponses: boolean }): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => clean(item, options));
  }
  if (node === null || typeof node !== "object") {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "minimum" && value === -9007199254740991) {
      continue;
    }
    if (key === "maximum" && value === 9007199254740991) {
      continue;
    }
    // Responses are open for additions (clients ignore unknown fields, design 6.6).
    if (options.openResponses && key === "additionalProperties" && value === false) {
      continue;
    }
    out[key] = clean(value, options);
  }
  return out;
}

function documentSchema(schema: z.ZodType, name: string, io: "input" | "output"): Json {
  const generated = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
  const { $schema, ...rest } = generated;
  return clean(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${SCHEMA_BASE}${name}.schema.json`,
      ...rest,
    },
    { openResponses: false },
  ) as Json;
}

/** The JSON Schemas written to `schemas/`, by file name. */
export function jsonSchemas(): Record<string, Json> {
  return {
    "release.schema.json": releaseJsonSchema as unknown as Json,
    "feed-index.schema.json": documentSchema(feedIndexSchema, "feed-index", "input"),
    "updater-config.schema.json": documentSchema(configObjectSchema, "updater-config", "input"),
    "status.schema.json": documentSchema(statusFileSchema, "status", "output"),
    "public-status.schema.json": documentSchema(publicStatusSchema, "public-status", "output"),
  };
}

class Components {
  readonly schemas: Record<string, Json> = {};

  /** A `$ref` to the component for `schema` (registered by its `id` metadata). */
  ref(schema: z.ZodType, io: "input" | "output"): Json {
    const generated = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Json;
    const text = JSON.stringify(generated).replaceAll('"#/$defs/', '"#/components/schemas/');
    const rewritten = clean(JSON.parse(text), { openResponses: io === "output" }) as Json;
    const defs = (rewritten.$defs ?? {}) as Record<string, Json>;
    for (const [name, definition] of Object.entries(defs)) {
      this.schemas[name] = definition;
    }
    if (typeof rewritten.$ref === "string") {
      return { $ref: rewritten.$ref };
    }
    const { $schema: _schema, $defs: _defs, ...inline } = rewritten;
    return inline;
  }
}

const json = (schema: Json) => ({ "application/json": { schema } });

/** The OpenAPI 3.1 document of the sidecar API (design 6.7). */
export function openApiDocument(): Json {
  const components = new Components();
  const problem = components.ref(problemSchema, "output");
  const problemResponse = (description: string) => ({
    description,
    content: { "application/problem+json": { schema: problem } },
  });
  const ok = (description: string, schema: z.ZodType) => ({
    description,
    content: json(components.ref(schema, "output")),
  });
  const authErrors = {
    "401": { $ref: "#/components/responses/Unauthorized" },
    default: { $ref: "#/components/responses/Problem" },
  };
  const refresh = {
    name: "refresh",
    in: "query",
    required: false,
    schema: { type: "boolean" },
    description: "Recompute instead of using the cache.",
  };
  const runId = {
    name: "runId",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^r-\\d{1,15}-[0-9a-f]{4}$" },
  };

  const paths: Json = {
    "/healthz": {
      get: {
        operationId: "getHealth",
        summary: "Liveness of the sidecar (container healthcheck).",
        security: [],
        responses: { "200": ok("The sidecar runs.", healthViewSchema) },
      },
    },
    "/public/v1/status": {
      get: {
        operationId: "getPublicStatus",
        summary: "What an anonymous visitor may see (for maintenance pages).",
        security: [],
        responses: {
          "200": ok("The public status.", publicStatusSchema),
          "404": problemResponse("The public status is disabled."),
        },
      },
    },
    "/v1/state": {
      get: {
        operationId: "getState",
        summary: "Everything a UI needs: phase, run, history, running version, capabilities.",
        parameters: [refresh],
        responses: { "200": ok("The state.", stateViewSchema), ...authErrors },
      },
    },
    "/v1/capabilities": {
      get: {
        operationId: "getCapabilities",
        summary: "The preflight result only.",
        parameters: [refresh],
        responses: { "200": ok("The capabilities.", capabilitiesSchema), ...authErrors },
      },
    },
    "/v1/releases": {
      get: {
        operationId: "listReleases",
        summary: "Newer releases from the configured feed, with refusals (metadata not verified).",
        parameters: [refresh],
        responses: {
          "200": ok("The releases.", releasesViewSchema),
          "502": problemResponse("The release host failed (feed_unavailable)."),
          ...authErrors,
        },
      },
    },
    "/v1/releases/{version}/verification": {
      post: {
        operationId: "verifyRelease",
        summary: "Dry run: fetch and verify release.json and the image signatures, no pull.",
        parameters: [
          {
            name: "version",
            in: "path",
            required: true,
            schema: { type: "string", maxLength: 64 },
          },
        ],
        responses: {
          "200": ok("The verification result.", verificationResultSchema),
          "404": problemResponse("No such release or no release.json (release_not_found)."),
          "422": problemResponse("The release does not verify (release_unverifiable)."),
          "502": problemResponse("The release host failed (feed_unavailable)."),
          ...authErrors,
        },
      },
    },
    "/v1/runs": {
      get: {
        operationId: "listRuns",
        summary: "History of runs (summaries, newest first).",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: { "200": ok("The runs.", runsViewSchema), ...authErrors },
      },
      post: {
        operationId: "scheduleRun",
        summary: "Schedule a run; the release is fully verified before it is accepted.",
        requestBody: {
          required: true,
          content: json(components.ref(scheduleRequestSchema, "input")),
        },
        responses: {
          "202": ok("The run is scheduled (or running when it starts at once).", stateViewSchema),
          "404": problemResponse("release_not_found"),
          "409": problemResponse(
            "busy, blocked, release_refused, release_mismatch or source_not_allowed",
          ),
          "422": problemResponse("invalid_request or release_unverifiable"),
          "502": problemResponse("feed_unavailable"),
          ...authErrors,
        },
      },
    },
    "/v1/runs/{runId}": {
      get: {
        operationId: "getRun",
        summary: "One run including its log.",
        parameters: [runId],
        responses: {
          "200": ok("The run.", runSchema),
          "404": problemResponse("not_found"),
          ...authErrors,
        },
      },
      patch: {
        operationId: "rescheduleRun",
        summary: "Move a scheduled run.",
        parameters: [runId],
        requestBody: {
          required: true,
          content: json(components.ref(rescheduleRequestSchema, "input")),
        },
        responses: {
          "200": ok("The run was moved.", stateViewSchema),
          "404": problemResponse("not_found"),
          "409": problemResponse("not_scheduled"),
          "422": problemResponse("invalid_request"),
          ...authErrors,
        },
      },
    },
    "/v1/runs/{runId}/cancel": {
      post: {
        operationId: "cancelRun",
        summary: "Cancel a scheduled run, or abort a running one before the point of no return.",
        parameters: [runId],
        requestBody: {
          required: false,
          content: json(components.ref(runActionRequestSchema, "input")),
        },
        responses: {
          "200": ok("Cancelled.", stateViewSchema),
          "202": ok("Abort requested; the run stops at its next check point.", stateViewSchema),
          "404": problemResponse("not_found"),
          "409": problemResponse("point_of_no_return or not_scheduled"),
          ...authErrors,
        },
      },
    },
    "/v1/runs/{runId}/acknowledge": {
      post: {
        operationId: "acknowledgeRun",
        summary: "Clear a finished run (it stays in the history).",
        parameters: [runId],
        requestBody: {
          required: false,
          content: json(components.ref(runActionRequestSchema, "input")),
        },
        responses: {
          "200": ok("Acknowledged.", stateViewSchema),
          "404": problemResponse("not_found"),
          "409": problemResponse("not_finished"),
          ...authErrors,
        },
      },
    },
    "/v1/events": {
      get: {
        operationId: "listEvents",
        summary: "Journal events after a cursor, for the app's audit log (exactly once).",
        parameters: [
          {
            name: "after",
            in: "query",
            required: false,
            schema: { type: "string", pattern: "^\\d{15}-\\d{6}$" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          },
        ],
        responses: { "200": ok("The events.", eventsViewSchema), ...authErrors },
      },
    },
    "/v1/backups": {
      get: {
        operationId: "listBackups",
        summary: "Backups with metadata and protection flag (never their content).",
        responses: { "200": ok("The backups.", backupsViewSchema), ...authErrors },
      },
    },
    "/v1/config": {
      get: {
        operationId: "getConfig",
        summary: "The effective configuration (redacted) and its hash.",
        responses: { "200": ok("The configuration.", configViewSchema), ...authErrors },
      },
    },
    "/v1/openapi.json": {
      get: {
        operationId: "getOpenApi",
        summary: "This document.",
        responses: {
          "200": {
            description: "The OpenAPI document.",
            content: { "application/json": { schema: { type: "object" } } },
          },
          ...authErrors,
        },
      },
    },
  };

  const problemCodes = Object.entries(PROBLEM_STATUS)
    .map(([code, status]) => `\`${code}\` (${status})`)
    .join(", ");

  return {
    openapi: "3.1.0",
    info: {
      title: "cicd-updater sidecar API",
      version: API_VERSION,
      description: `HTTP API of the cicd-updater sidecar. Everything under /v1 requires \`Authorization: Bearer <token>\`. Errors are RFC 9457 problem documents (application/problem+json) with \`type: urn:cicd-updater:problem:<code>\`; codes: ${problemCodes}. Clients must ignore unknown fields and render unknown codes generically.`,
      license: { name: "Apache-2.0", identifier: "Apache-2.0" },
    },
    servers: [{ url: "http://updater:8090" }],
    security: [{ bearerToken: [] }],
    paths,
    components: {
      securitySchemes: { bearerToken: { type: "http", scheme: "bearer" } },
      responses: {
        Problem: problemResponse("An RFC 9457 problem document."),
        Unauthorized: {
          description: "Missing or wrong bearer token (unauthorized).",
          headers: { "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer" } },
          content: { "application/problem+json": { schema: problem } },
        },
      },
      schemas: Object.fromEntries(
        Object.entries(components.schemas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    },
  };
}
