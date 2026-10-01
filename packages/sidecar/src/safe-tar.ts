import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createGunzip } from "node:zlib";

/**
 * A small, strict tar.gz extractor for source archives (design 8.4). It
 * refuses absolute paths, `..` segments, links that point outside the tree,
 * hard links and device files, drops the archive's top-level directory (as
 * GitHub, Forgejo and GitLab archives have one), never keeps owners or
 * set-id bits, and stops past a size and entry limit.
 */

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

export interface ExtractOptions {
  /** Leading path components to drop (default 1). */
  stripComponents?: number;
  /** Total bytes of file content allowed (decompression bomb guard). */
  maxBytes: number;
  maxEntries?: number;
}

interface Header {
  name: string;
  mode: number;
  size: number;
  type: string;
  linkname: string;
}

const BLOCK = 512;

function cstring(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(buffer: Buffer, start: number, length: number): number {
  const field = buffer.subarray(start, start + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    // GNU base-256 encoding (large files).
    let value = 0;
    for (let index = 1; index < field.length; index++) {
      value = value * 256 + (field[index] ?? 0);
    }
    return value;
  }
  const text = cstring(buffer, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function checksumOk(block: Buffer): boolean {
  const stored = octal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
  }
  return sum === stored;
}

function parseHeader(block: Buffer): Header {
  if (!checksumOk(block)) {
    throw new UnsafeArchiveError("The archive has a damaged header.");
  }
  const name = cstring(block, 0, 100);
  const magic = cstring(block, 257, 6);
  const prefix = magic.startsWith("ustar") ? cstring(block, 345, 155) : "";
  return {
    name: prefix ? `${prefix}/${name}` : name,
    mode: octal(block, 100, 8),
    size: octal(block, 124, 12),
    type: String.fromCharCode(block[156] ?? 0),
    linkname: cstring(block, 157, 100),
  };
}

/** PAX records `<length> <key>=<value>\n`. */
function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) {
      break;
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) {
      records[record.slice(0, equals)] = record.slice(equals + 1);
    }
    offset += length;
  }
  return records;
}

/** The safe relative path of an entry after stripping, or null for the stripped top level. */
export function safeEntryPath(name: string, strip: number): string | null {
  if (name.includes("\0")) {
    throw new UnsafeArchiveError("An entry name contains NUL.");
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new UnsafeArchiveError(`The archive contains an absolute path: ${name}`);
  }
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) {
    throw new UnsafeArchiveError(`The archive contains a path with "..": ${name}`);
  }
  const kept = parts.slice(strip);
  return kept.length === 0 ? null : kept.join("/");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Async block reader over a gunzip stream. */
class BlockReader {
  private buffer = Buffer.alloc(0);
  private done = false;
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async read(length: number): Promise<Buffer | null> {
    while (this.buffer.length < length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
      } else {
        this.buffer = Buffer.concat([this.buffer, next.value]);
      }
    }
    if (this.buffer.length < length) {
      return null;
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }
}

/** Extract `archive` (tar.gz) into `destination` (created, must be empty or absent). */
export async function extractTarGz(
  archive: string,
  destination: string,
  options: ExtractOptions,
): Promise<number> {
  const strip = options.stripComponents ?? 1;
  const maxEntries = options.maxEntries ?? 200_000;
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  const root = await fs.realpath(destination);
  const reader = new BlockReader(
    createReadStream(archive).pipe(createGunzip()) as AsyncIterable<Buffer>,
  );
  let total = 0;
  let entries = 0;
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  let emptyBlocks = 0;

  for (;;) {
    const block = await reader.read(BLOCK);
    if (!block) {
      break;
    }
    if (block.every((byte) => byte === 0)) {
      emptyBlocks += 1;
      if (emptyBlocks >= 2) {
        break;
      }
      continue;
    }
    emptyBlocks = 0;
    const header = parseHeader(block);
    const size = header.size;
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    if (header.type === "x" || header.type === "g" || header.type === "L" || header.type === "K") {
      if (size > 1024 * 1024) {
        throw new UnsafeArchiveError("An extended header is too large.");
      }
      const data = (await reader.read(padded))?.subarray(0, size);
      if (!data) {
        throw new UnsafeArchiveError("The archive ends inside an extended header.");
      }
      if (header.type === "x") {
        pax = parsePax(data);
      } else if (header.type === "L") {
        longName = cstring(data, 0, data.length);
      } else if (header.type === "K") {
        longLink = cstring(data, 0, data.length);
      }
      continue;
    }

    entries += 1;
    if (entries > maxEntries) {
      throw new UnsafeArchiveError("The archive has too many entries.");
    }
    const name = pax.path ?? longName ?? header.name;
    const linkname = pax.linkpath ?? longLink ?? header.linkname;
    const entrySize = pax.size !== undefined ? Number(pax.size) : size;
    pax = {};
    longName = null;
    longLink = null;
    const entryPadded = Math.ceil(entrySize / BLOCK) * BLOCK;
    const relative = safeEntryPath(name, strip);
    const target = relative ? path.join(root, relative) : null;
    if (target && !inside(root, target)) {
      throw new UnsafeArchiveError(`The archive contains a path outside the tree: ${name}`);
    }

    switch (header.type) {
      case "0":
      case "\0":
      case "7": {
        total += entrySize;
        if (total > options.maxBytes) {
          throw new UnsafeArchiveError("The archive content is larger than allowed.");
        }
        if (!target) {
          await skip(reader, entryPadded);
          break;
        }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        if (!inside(root, await fs.realpath(path.dirname(target)))) {
          throw new UnsafeArchiveError(
            `The archive writes through a link outside the tree: ${name}`,
          );
        }
        const handle = await fs.open(target, "wx", (header.mode & 0o755) | 0o600);
        try {
          let remaining = entrySize;
          while (remaining > 0) {
            const chunk = await reader.read(Math.min(remaining, 64 * 1024));
            if (!chunk) {
              throw new UnsafeArchiveError("The archive ends inside a file.");
            }
            await handle.write(chunk);
            remaining -= chunk.length;
          }
        } finally {
          await handle.close();
        }
        await skip(reader, entryPadded - entrySize);
        break;
      }
      case "5":
        if (target) {
          await fs.mkdir(target, { recursive: true, mode: 0o755 });
        }
        await skip(reader, entryPadded);
        break;
      case "2": {
        if (!target) {
          await skip(reader, entryPadded);
          break;
        }
        if (
          linkname.startsWith("/") ||
          !inside(root, path.resolve(path.dirname(target), linkname))
        ) {
          throw new UnsafeArchiveError(
            `The archive contains a link pointing outside the tree: ${name} -> ${linkname}`,
          );
        }
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await fs.symlink(linkname, target);
        await skip(reader, entryPadded);
        break;
      }
      case "1":
        throw new UnsafeArchiveError(`The archive contains a hard link: ${name}`);
      case "3":
      case "4":
      case "6":
        throw new UnsafeArchiveError(`The archive contains a device file or FIFO: ${name}`);
      default:
        throw new UnsafeArchiveError(
          `The archive contains an unsupported entry type '${header.type}': ${name}`,
        );
    }
  }
  return entries;
}

async function skip(reader: BlockReader, bytes: number): Promise<void> {
  let remaining = bytes;
  while (remaining > 0) {
    const chunk = await reader.read(Math.min(remaining, 64 * 1024));
    if (!chunk) {
      throw new UnsafeArchiveError("The archive ends early.");
    }
    remaining -= chunk.length;
  }
}
