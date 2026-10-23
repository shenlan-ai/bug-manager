import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "./errors.js";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function boundedText(
  value: string,
  maxChars: number,
  edge: "start" | "end" = "start",
) {
  let start = edge === "end" ? Math.max(0, value.length - maxChars) : 0,
    end = edge === "start" ? Math.min(maxChars, value.length) : value.length;
  if (
    start > 0 &&
    value.charCodeAt(start) >= 0xdc00 &&
    value.charCodeAt(start) <= 0xdfff
  )
    start++;
  if (
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff
  )
    end--;
  return value.slice(start, end);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
export async function normalizePath(input: string): Promise<string> {
  const absolute = path.resolve(input);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch {
    resolved = absolute;
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function normalizeName(input: string) {
  return input.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
export function searchTokens(input: string): string[] {
  const normalized = normalizeName(input);
  const tokens = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []);
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = [...sequence];
    if (chars.length === 1) tokens.add(sequence);
    for (let i = 0; i < chars.length - 1; i++)
      tokens.add(chars.slice(i, i + 2).join(""));
  }
  return [...tokens].slice(0, 4096);
}
export function parseCursor(
  value: string | undefined,
  scope: string,
): { last: string; watermark: string; revision?: number } | undefined {
  if (!value) return undefined;
  try {
    const c: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      typeof c === "object" &&
      c !== null &&
      "scope" in c &&
      c.scope === scope &&
      "last" in c &&
      typeof c.last === "string" &&
      "watermark" in c &&
      typeof c.watermark === "string"
    )
      return {
        last: c.last,
        watermark: c.watermark,
        ...("revision" in c && typeof c.revision === "number"
          ? { revision: c.revision }
          : {}),
      };
  } catch {
    /* Return stable error rather than exposing parser internals. */
  }
  throw new DomainError(
    "invalid_cursor",
    "Cursor does not belong to this query",
  );
}
export const makeCursor = (
  last: string,
  watermark: string,
  scope: string,
  revision?: number,
) =>
  Buffer.from(JSON.stringify({ last, watermark, scope, revision })).toString(
    "base64url",
  );
