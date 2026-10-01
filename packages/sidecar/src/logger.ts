import type { Logger, Redactor } from "@cicd-updater/engine";

/**
 * The sidecar's log (design 4.3 `logging`): `text` lines
 * `<time> <LEVEL> <message>` or `json` objects, one per line; every line
 * passes the redactor.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function consoleLogger(options: {
  redactor: Redactor;
  level: LogLevel;
  format: "text" | "json";
  now?: () => Date;
  write?: (stream: "stdout" | "stderr", line: string) => void;
}): Logger {
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((stream, line) => {
      (stream === "stdout" ? process.stdout : process.stderr).write(`${line}\n`);
    });
  const emit = (level: LogLevel, message: string): void => {
    if (ORDER[level] < ORDER[options.level]) {
      return;
    }
    const text = options.redactor.oneLine(message, 4000);
    const time = now().toISOString();
    const line =
      options.format === "json"
        ? JSON.stringify({ time, level, message: text })
        : `${time} ${level.toUpperCase()} ${text}`;
    write(level === "warn" || level === "error" ? "stderr" : "stdout", line);
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}
