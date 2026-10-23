import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import type { Locator } from "./types.js";

export type SourceLine = (
  | { kind: "record"; value: unknown }
  | { kind: "ignored" }
  | {
      kind: "issue";
      code: "invalid_json" | "invalid_utf8" | "line_too_large";
      continuation?: boolean;
    }
  | { kind: "incomplete"; code: "pending_write" | "budget_exhausted" }
) &
  Locator;
export interface ReaderOptions {
  offset?: number;
  line_number?: number;
  max_line_bytes?: number;
  max_bytes?: number;
  chunk_bytes?: number;
  signal?: AbortSignal;
  skip_oversized?: boolean;
  max_records?: number;
}

export async function* readJsonl(
  filename: string,
  options: ReaderOptions = {},
): AsyncGenerator<SourceLine> {
  for (const value of [
    options.offset ?? 0,
    options.line_number ?? 1,
    options.max_line_bytes ?? 1,
    options.max_bytes ?? 1,
    options.chunk_bytes ?? 1,
    options.max_records ?? 1,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Invalid history reader bounds");
  if (
    options.chunk_bytes === 0 ||
    options.max_bytes === 0 ||
    options.max_line_bytes === 0 ||
    options.max_records === 0
  )
    throw new Error("History reader budgets must be positive");
  const file = await open(filename, "r"),
    start = options.offset ?? 0,
    maxLine = options.max_line_bytes ?? 4 * 1024 * 1024,
    maxBytes = options.max_bytes ?? 32 * 1024 * 1024;
  let position = start,
    lineStart = start,
    lineNumber = options.line_number ?? 1,
    pieces: Buffer[] = [],
    length = 0,
    oversized = options.skip_oversized ?? false;
  const buffer = Buffer.alloc(options.chunk_bytes ?? 64 * 1024),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let records = 0;
  try {
    reading: while (!options.signal?.aborted && position - start < maxBytes) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, maxBytes - (position - start)),
        position,
      );
      if (!bytesRead) break;
      let begin = 0;
      while (begin < bytesRead) {
        const newline = buffer.indexOf(10, begin),
          end = newline >= 0 && newline < bytesRead ? newline : bytesRead;
        const part = buffer.subarray(begin, end);
        length += part.length;
        if (length > maxLine) {
          oversized = true;
          pieces = [];
        } else if (!oversized) pieces.push(Buffer.from(part));
        if (end === bytesRead) break;
        const locator = {
          byte_start: lineStart,
          byte_end: position + end + 1,
          line_number: lineNumber,
        };
        if (oversized)
          yield { kind: "issue", code: "line_too_large", ...locator };
        else {
          let text: string | undefined;
          try {
            text = decoder
              .decode(Buffer.concat(pieces))
              .replace(/^\uFEFF/, "")
              .trim();
          } catch {
            yield { kind: "issue", code: "invalid_utf8", ...locator };
          }
          if (text !== undefined) {
            if (!text) yield { kind: "ignored", ...locator };
            else {
              try {
                const value: unknown = JSON.parse(text);
                yield { kind: "record", value, ...locator };
              } catch {
                yield { kind: "issue", code: "invalid_json", ...locator };
              }
            }
          }
        }
        pieces = [];
        length = 0;
        oversized = false;
        lineStart = locator.byte_end;
        lineNumber++;
        begin = end + 1;
        records++;
        if (records >= (options.max_records ?? 10000)) {
          position = locator.byte_end;
          break reading;
        }
      }
      position += bytesRead;
    }
    const size = (await file.stat()).size;
    if (oversized)
      yield {
        kind: "issue",
        code: "line_too_large",
        continuation: true,
        byte_start: lineStart,
        byte_end: position,
        line_number: lineNumber,
      };
    else if (length > 0 || position < size)
      yield {
        kind: "incomplete",
        code:
          position < size || position - start >= maxBytes
            ? "budget_exhausted"
            : "pending_write",
        byte_start: lineStart,
        byte_end: position,
        line_number: lineNumber,
      };
  } finally {
    await file.close();
  }
}
