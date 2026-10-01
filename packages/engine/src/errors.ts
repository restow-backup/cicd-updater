import type { Blocker, ProblemCode, RefusalCode, VerificationResult } from "@cicd-updater/protocol";

/** A request the engine refuses; the server turns it into an RFC 9457 problem. */
export class EngineError extends Error {
  constructor(
    readonly code: ProblemCode,
    message: string,
    readonly extensions: {
      blockers?: Blocker[];
      reasons?: RefusalCode[];
      checks?: VerificationResult;
      feedError?: string;
      errors?: { path: string; message: string }[];
    } = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** The process is shutting down; the run is left as it is and resolved at the next start. */
export class ShutdownSignal extends Error {
  constructor() {
    super("shutting down");
    this.name = "ShutdownSignal";
  }
}
