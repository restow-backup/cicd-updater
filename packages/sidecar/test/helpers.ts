import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { gzipSync } from "node:zlib";
import type { CommandResult, CommandRunner, CommandSpec, Program } from "../src/index.js";

type Answer = Partial<CommandResult> & { file?: string | Buffer };

/**
 * A CommandRunner that records every spec and answers from scripted rules
 * (the last matching rule wins). `file` content is written to `stdoutFile`
 * (gzipped when asked) and reported as `written`.
 */
export class ScriptedRunner implements CommandRunner {
  readonly specs: CommandSpec[] = [];
  private readonly rules: ((spec: CommandSpec) => Answer | undefined)[] = [];
  missing = new Set<Program>();

  answer(rule: (spec: CommandSpec) => Answer | undefined): this {
    this.rules.push(rule);
    return this;
  }

  /** Answer specs whose argv contains every given fragment. */
  when(fragments: string[], answer: Answer): this {
    return this.answer((spec) =>
      fragments.every((fragment) => spec.argv.includes(fragment)) ? answer : undefined,
    );
  }

  available(program: Program): boolean {
    return !this.missing.has(program);
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.specs.push(spec);
    let answer: Answer | undefined;
    for (const rule of [...this.rules].reverse()) {
      answer = rule(spec);
      if (answer) break;
    }
    const { file, ...rest } = answer ?? {};
    let written: CommandResult["written"] = null;
    if (spec.stdoutFile) {
      const raw = typeof file === "string" ? Buffer.from(file) : (file ?? Buffer.alloc(0));
      const body = spec.gzipStdout ? gzipSync(raw) : raw;
      await fs.writeFile(spec.stdoutFile, body, { mode: 0o600, flag: "wx" });
      written = { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    }
    return {
      exitCode: 0,
      stdout: "",
      errorTail: "",
      timedOut: false,
      aborted: false,
      truncated: false,
      written,
      ...rest,
    };
  }

  get argvs(): string[][] {
    return this.specs.map((spec) => [...spec.argv]);
  }

  /** Every argument and environment value of every command, for secret checks. */
  everything(): string {
    return this.specs
      .map((spec) => [...spec.argv, ...Object.values(spec.env ?? {})].join(" "))
      .join("\n");
  }
}

/** A minimal ustar writer for archive tests (PAX headers for names over 100 bytes). */
export function tar(
  entries: { name: string; type?: string; body?: string; linkname?: string; mode?: number }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    let name = entry.name;
    if (Buffer.byteLength(name) > 100) {
      const base = ` path=${name}\n`;
      let length = base.length + 1;
      while (String(length).length + base.length !== length) {
        length += 1;
      }
      blocks.push(tarHeaderAndBody("PaxHeader", "x", Buffer.from(`${length}${base}`), "", 0o644));
      name = "placeholder";
    }
    blocks.push(
      tarHeaderAndBody(name, entry.type ?? "0", body, entry.linkname ?? "", entry.mode ?? 0o644),
    );
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function tarHeaderAndBody(
  name: string,
  type: string,
  body: Buffer,
  linkname: string,
  mode: number,
): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

export function tarGz(entries: Parameters<typeof tar>[0]): Buffer {
  return gzipSync(tar(entries));
}

/** The error a promise rejects with (fails when it resolves). */
export async function rejection<T = Error>(promise: Promise<unknown>): Promise<T> {
  try {
    await promise;
  } catch (error) {
    return error as T;
  }
  throw new Error("expected the promise to reject");
}
