import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ContextSegmenter,
  initialAdapterState,
  normalizeHistoryRecord,
  readJsonl,
  canonical,
  hash,
} from "@bug-manager/core";
import type { HistoryEvent } from "@bug-manager/core";

describe("history adapters and streaming boundaries", () => {
  let directory: string, filename: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "bm-history-unit-"));
    filename = path.join(directory, "synthetic.jsonl");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const lines = async (
    file: string,
    options: Parameters<typeof readJsonl>[1] = {},
  ) => {
    const rows = [];
    for await (const row of readJsonl(file, options)) rows.push(row);
    return rows;
  };
  it("HIS-001 reports unsupported data, excludes reasoning/binary, and never changes source", async () => {
    const source =
      [
        {
          type: "session_meta",
          payload: {
            id: "synthetic-session",
            cwd: "/synthetic",
            cli_version: "fixture-only",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "报错 sk-syntheticSecret1234567890",
              },
              { type: "image", data: "binary-must-not-persist" },
            ],
          },
        },
        {
          type: "response_item",
          payload: { type: "reasoning", summary: "private-reasoning" },
        },
        { type: "future_record", payload: { text: "unknown text" } },
      ]
        .map(canonical)
        .join("\n") + "\n";
    await writeFile(filename, source);
    const before = hash(await readFile(filename)),
      state = initialAdapterState(filename),
      normalized = [];
    for (const line of await lines(filename, { chunk_bytes: 3 }))
      if (line.kind === "record")
        normalized.push(
          normalizeHistoryRecord("codex", line.value, state, line),
        );
    expect(hash(await readFile(filename))).toBe(before);
    expect(normalized[0]!.warnings).toContain("unverified_client_version");
    expect(normalized[1]!.events[0]!.text).toContain("[REDACTED_API_KEY]");
    expect(normalized[1]!.warnings).toContain("unsupported_content:image");
    expect(normalized[2]!.coverage).toBe("excluded");
    expect(normalized[3]!.coverage).toBe("unknown");
    expect(canonical(normalized)).not.toContain("binary-must-not-persist");
    expect(canonical(normalized)).not.toContain("private-reasoning");
  });
  it("HIS-001 pairs duplicate Codex representations without dropping repeated turns or tool outputs", () => {
    const state = initialAdapterState(filename),
      emit = (raw: unknown, line: number) =>
        normalizeHistoryRecord("codex", raw, state, {
          byte_start: line,
          byte_end: line + 1,
          line_number: line,
        });
    const user = {
      type: "event_msg",
      payload: { type: "user_message", message: "same" },
    };
    const response = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "same" }],
      },
    };
    expect(emit(user, 1).events).toHaveLength(1);
    expect(emit(response, 2).events).toHaveLength(0);
    expect(emit(user, 3).events).toHaveLength(1);
    expect(emit(response, 4).events).toHaveLength(0);
    const call = emit(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "c1",
          name: "test",
          arguments: "{}",
        },
      },
      5,
    ).events[0]!;
    const output = emit(
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: "failed",
        },
      },
      6,
    ).events[0]!;
    expect(call.event_id).not.toBe(output.event_id);
  });
  it("HIS-001 recognizes sampled Codex runtime records without persisting context snapshots", () => {
    const state = initialAdapterState(filename);
    const emit = (raw: unknown, line: number) =>
      normalizeHistoryRecord("codex", raw, state, {
        byte_start: line,
        byte_end: line + 1,
        line_number: line,
      });
    const meta = emit(
      {
        type: "session_meta",
        payload: { id: "sample-shape", cli_version: "0.162.0-alpha.17.2" },
      },
      1,
    );
    expect(meta.warnings).not.toContain("unverified_client_version");
    const usage = emit(
      { type: "token_usage_record", payload: { usage: { input_tokens: 12 } } },
      2,
    );
    expect(usage).toMatchObject({ coverage: "metadata", events: [] });
    const snapshot = emit(
      {
        type: "world_state",
        payload: { full: true, state: { instructions: "private-context" } },
      },
      3,
    );
    expect(snapshot).toMatchObject({ coverage: "excluded", events: [] });
    expect(canonical(snapshot)).not.toContain("private-context");
    expect(
      emit({ type: "future_record", payload: { text: "unknown" } }, 4).coverage,
    ).toBe("unknown");
  });
  it("HIS-001 preserves Claude agent/branch identity and tool content", () => {
    const state = initialAdapterState(
      path.join(directory, "agent-fixture.jsonl"),
    );
    const result = normalizeHistoryRecord(
      "claude",
      {
        type: "assistant",
        sessionId: "parent-session",
        uuid: "message",
        parentUuid: "branch-parent",
        cwd: "/synthetic",
        message: {
          content: [
            { type: "text", text: "failure description" },
            { type: "tool_use", name: "test", input: { retry: true } },
            { type: "thinking", thinking: "excluded" },
          ],
        },
      },
      state,
      { byte_start: 0, byte_end: 100, line_number: 1 },
    );
    expect(result.events[0]).toMatchObject({
      session_id: "parent-session/agent-fixture",
      parent_id: "branch-parent",
    });
    expect(result.events[0]!.text).toContain("Tool test");
    expect(result.events[0]!.text).not.toContain("excluded");
    expect(result.warnings).toContain("unsupported_content:thinking");
  });
  it("HIS-006 waits for incomplete JSON and UTF-8, then resumes at an exact byte boundary", async () => {
    const first = Buffer.from('{"text":"first"}\r\n'),
      second = Buffer.from('{"text":"中文🙂"}\n');
    await writeFile(
      filename,
      Buffer.concat([first, second.subarray(0, second.length - 5)]),
    );
    const before = await lines(filename, { chunk_bytes: 1 });
    expect(before[0]!.kind).toBe("record");
    expect(before.at(-1)).toMatchObject({
      kind: "incomplete",
      code: "pending_write",
      byte_start: first.length,
    });
    await appendFile(filename, second.subarray(second.length - 5));
    expect(
      await lines(filename, {
        offset: first.length,
        line_number: 2,
        chunk_bytes: 2,
      }),
    ).toEqual([
      {
        kind: "record",
        value: { text: "中文🙂" },
        byte_start: first.length,
        byte_end: first.length + second.length,
        line_number: 2,
      },
    ]);
  });
  it("HIS-006 distinguishes invalid UTF-8, malformed JSON and bounded oversized-line continuation", async () => {
    await writeFile(
      filename,
      Buffer.concat([
        Buffer.from([0xff, 10]),
        Buffer.from("broken\n" + "x".repeat(100) + '\n{"valid":true}\n'),
      ]),
    );
    const first = await lines(filename, {
      max_line_bytes: 20,
      max_bytes: 60,
      chunk_bytes: 3,
    });
    expect(
      first.slice(0, 2).map((l) => (l.kind === "issue" ? l.code : l.kind)),
    ).toEqual(["invalid_utf8", "invalid_json"]);
    expect(first.at(-1)).toMatchObject({
      kind: "issue",
      code: "line_too_large",
      continuation: true,
    });
    const resumed = await lines(filename, {
      offset: first.at(-1)!.byte_end,
      line_number: 3,
      skip_oversized: true,
      max_line_bytes: 20,
      max_bytes: 100,
    });
    expect(resumed[0]).toMatchObject({ kind: "issue", code: "line_too_large" });
    expect(resumed.at(-1)).toMatchObject({
      kind: "record",
      value: { valid: true },
    });
  });
  it("HIS-003 bounds Unicode parts, retains context and restores unflushed events", () => {
    const event: HistoryEvent = {
      adapter: "codex",
      session_id: "s",
      event_id: "e",
      role: "user",
      text: "现象🙂".repeat(100),
      byte_start: 0,
      byte_end: 500,
      line_number: 1,
    };
    const segmenter = new ContextSegmenter(65),
      segments = segmenter.push(event),
      restored = new ContextSegmenter(65, segmenter.checkpoint());
    const tail = restored.flush()!;
    segments.push(tail);
    const recovered = segments
      .map((s) => s.excerpt.replace(/^\[user\] /, ""))
      .join("");
    expect(recovered).toBe(event.text);
    expect(segments.every((s) => !s.excerpt.includes("\ufffd"))).toBe(true);
    expect(segments[1]!.context).toContain("现象");
    expect(segments[1]!.summary_hash).not.toBe(segments[0]!.summary_hash);
    expect(segments.every((s) => s.ranges[0]!.char_end !== undefined)).toBe(
      true,
    );
  });
  it("HIS-003 retains the latest user guidance beyond bounded adjacent context", () => {
    const guidance = "人工引导：请检查复杂配置页里的父标题是否小于正文";
    const segmenter = new ContextSegmenter(80),
      segments = [
        ...segmenter.push({
          adapter: "codex",
          session_id: "s",
          event_id: "guidance",
          role: "user",
          text: guidance,
          byte_start: 0,
          byte_end: guidance.length,
          line_number: 1,
        }),
      ];
    for (let index = 0; index < 10; index++)
      segments.push(
        ...segmenter.push({
          adapter: "codex",
          session_id: "s",
          event_id: `tool-${index}`,
          role: "tool",
          text: `工具输出 ${index} `.repeat(8),
          byte_start: index + 1,
          byte_end: index + 2,
          line_number: index + 2,
        }),
      );
    segments.push(segmenter.flush()!);
    const lastContext = JSON.parse(segments.at(-1)!.context) as {
      events: Array<{ role: string; text: string }>;
    };
    expect(lastContext.events[0]).toMatchObject({
      role: "user",
      text: guidance,
    });
  });
});
