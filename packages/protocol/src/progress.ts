import type { PublicStatus } from "./api.js";
import { type Phase, QUIESCED_STEP_ORDER, STEP_IDS, STEP_WEIGHTS, type StepId } from "./codes.js";
import type { Message, Run, Step } from "./status.js";

/** The steps in execution order (design 5.2). */
export function stepOrder(quiesce: boolean): StepId[] {
  return quiesce ? [...QUIESCED_STEP_ORDER] : [...STEP_IDS];
}

/** A fresh list of steps: `skipped` from the start for the given ids, pending otherwise. */
export function initialSteps(order: readonly StepId[], skipped: ReadonlySet<StepId>): Step[] {
  return order.map((id) => ({
    id,
    status: skipped.has(id) ? ("skipped" as const) : ("pending" as const),
    startedAt: null,
    finishedAt: null,
    detail: {},
  }));
}

/**
 * Percent done: the weights of done and skipped steps plus half the weight of
 * the running step, rounded. Callers keep it from decreasing.
 */
export function progressOf(steps: readonly Pick<Step, "id" | "status">[]): number {
  let done = 0;
  for (const step of steps) {
    const weight = STEP_WEIGHTS[step.id];
    if (step.status === "done" || step.status === "skipped") {
      done += weight;
    } else if (step.status === "running") {
      done += weight / 2;
    }
  }
  return Math.max(0, Math.min(100, Math.round(done)));
}

/** Message parameters an anonymous visitor may not see. */
const PRIVATE_PARAMS: ReadonlySet<string> = new Set(["version"]);

function publicMessage(message: Message | null, showVersions: boolean): Message | null {
  if (!message) {
    return null;
  }
  if (showVersions) {
    return { code: message.code, params: { ...message.params } };
  }
  const params: Message["params"] = {};
  for (const [key, value] of Object.entries(message.params)) {
    if (!PRIVATE_PARAMS.has(key)) {
      params[key] = value;
    }
  }
  return { code: message.code, params };
}

/** The public status while nothing is announced (also what an edge may answer when no sidecar runs). */
export function idlePublicStatus(now: Date): PublicStatus {
  return {
    phase: "idle",
    runId: null,
    outcome: null,
    startsAt: null,
    startedAt: null,
    finishedAt: null,
    step: null,
    steps: [],
    progress: 0,
    message: null,
    failureCode: null,
    serverTime: now.toISOString(),
  };
}

/**
 * What an anonymous visitor may see of a run (design 6.5): no user, no image,
 * no log, no path, and no versions unless `showVersions`.
 */
export function publicStatusOf(
  phase: Phase,
  run: Run | null,
  now: Date,
  showVersions = false,
): PublicStatus {
  if (!run || phase === "idle") {
    return { ...idlePublicStatus(now), phase };
  }
  const status: PublicStatus = {
    phase,
    runId: run.id,
    outcome: run.outcome,
    startsAt: run.startsAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    step: run.step,
    steps: run.steps.map((step) => ({ id: step.id, status: step.status })),
    progress: run.progress,
    message: publicMessage(run.message, showVersions),
    failureCode: run.failure?.code ?? null,
    serverTime: now.toISOString(),
  };
  if (showVersions) {
    status.targetVersion = run.targetVersion;
    status.fromVersion = run.fromVersion;
  }
  return status;
}
