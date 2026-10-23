import path from "node:path";
import os from "node:os";
import { hash } from "../util.js";
import { redact } from "../privacy.js";
import type {
  AdapterState,
  HistoryAdapter,
  HistoryEvent,
  Locator,
  NormalizedRecord,
} from "./types.js";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const string = (v: unknown) => (typeof v === "string" ? v : undefined);
export function initialAdapterState(filename: string): AdapterState {
  return {
    session_id: path.basename(filename, ".jsonl").slice(0, 200),
    identity: "filename_fallback",
    recent: [],
    ...(path.basename(filename).startsWith("agent-")
      ? { agent_id: path.basename(filename, ".jsonl") }
      : {}),
  };
}
function contentText(content: unknown, warnings: string[], depth = 0): string {
  if (depth > 8) {
    warnings.push("content_depth_exceeded");
    return "";
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.length > 10_000) warnings.push("content_count_exceeded");
    return content
      .slice(0, 10_000)
      .map((c) => contentText(c, warnings, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const c = object(content),
    type = string(c.type);
  if (["input_text", "output_text", "text"].includes(type ?? ""))
    return string(c.text) ?? "";
  if (type === "tool_result")
    return contentText(c.content, warnings, depth + 1);
  if (type === "tool_use")
    return `Tool ${string(c.name) ?? "unknown"} input: ${JSON.stringify(c.input ?? {})}`;
  if (type) warnings.push(`unsupported_content:${type.slice(0, 100)}`);
  return "";
}

export function normalizeHistoryRecord(
  adapter: HistoryAdapter,
  raw: unknown,
  state: AdapterState,
  locator: Locator,
): NormalizedRecord {
  const record = object(raw),
    type = string(record.type),
    events: HistoryEvent[] = [],
    warnings: string[] = [];
  let coverage: NormalizedRecord["coverage"] = "recognized";
  function emit(
    role: HistoryEvent["role"],
    text: string,
    eventId: string,
    origin: string,
    parent?: string,
  ) {
    if (!text.trim()) return;
    const safe = redact(text),
      fingerprint = hash(`${role}:${safe}`);
    const paired = state.recent.findIndex(
      (e) =>
        e.hash === fingerprint &&
        e.origin !== origin &&
        locator.line_number - e.line >= 0 &&
        locator.line_number - e.line <= 8,
    );
    if (paired >= 0) {
      state.recent.splice(paired, 1);
      return;
    }
    state.recent = [
      ...state.recent.slice(-7),
      { hash: fingerprint, origin, line: locator.line_number },
    ];
    events.push({
      byte_start: locator.byte_start,
      byte_end: locator.byte_end,
      line_number: locator.line_number,
      adapter,
      session_id: state.session_id,
      event_id: eventId,
      role,
      text: safe,
      cwd: state.cwd,
      parent_id: parent,
    });
  }
  if (adapter === "codex") {
    const p = object(record.payload),
      payloadType = string(p.type);
    if (type === "session_meta") {
      const session = string(p.id);
      if (session) {
        state.session_id = session.slice(0, 200);
        state.identity = "declared";
      }
      state.cwd = string(p.cwd) ?? state.cwd;
      coverage = "metadata";
      state.client_version = string(p.cli_version);
      if (
        state.client_version &&
        !adapterCapabilities.codex.real_client_versions_verified.includes(
          state.client_version,
        )
      )
        warnings.push("unverified_client_version");
    } else if (type === "turn_context") {
      state.cwd = string(p.cwd) ?? state.cwd;
      state.recent = [];
      coverage = "metadata";
    } else if (type === "response_item") {
      const eventId = `${payloadType ?? "unknown"}:${string(p.id) ?? string(p.call_id) ?? `line:${locator.line_number}`}`;
      if (payloadType === "message") {
        const role =
          p.role === "user"
            ? "user"
            : p.role === "assistant"
              ? "assistant"
              : p.role === "tool"
                ? "tool"
                : undefined;
        if (role)
          emit(role, contentText(p.content, warnings), eventId, "response");
        else coverage = "excluded";
      } else if (
        payloadType === "function_call_output" ||
        payloadType === "custom_tool_call_output"
      )
        emit("tool", contentText(p.output, warnings), eventId, "response");
      else if (
        payloadType === "function_call" ||
        payloadType === "custom_tool_call"
      )
        emit(
          "tool",
          `Tool ${string(p.name) ?? "unknown"} input: ${string(p.arguments) ?? string(p.input) ?? ""}`,
          eventId,
          "response",
        );
      else if (payloadType === "reasoning") coverage = "excluded";
      else {
        coverage = "unknown";
        warnings.push(`unknown_response_type:${payloadType ?? "missing"}`);
      }
    } else if (type === "event_msg") {
      if (payloadType === "user_message")
        emit(
          "user",
          string(p.message) ?? "",
          `event:${locator.line_number}`,
          "event",
        );
      else if (payloadType === "agent_message")
        emit(
          "assistant",
          string(p.message) ?? "",
          `event:${locator.line_number}`,
          "event",
        );
      else if (
        [
          "task_started",
          "task_complete",
          "turn_aborted",
          "token_count",
          "agent_reasoning",
          "context_compacted",
          "item_completed",
        ].includes(payloadType ?? "")
      )
        coverage = payloadType === "agent_reasoning" ? "excluded" : "metadata";
      else {
        coverage = "unknown";
        warnings.push(`unknown_event_type:${payloadType ?? "missing"}`);
      }
    } else if (type === "token_usage_record") {
      coverage = "metadata";
    } else if (type === "world_state") {
      // Runtime context snapshots are not conversation evidence. They may contain
      // environment/instruction data that must not enter extracted knowledge.
      coverage = "excluded";
    } else if (type === "compacted") {
      const text = string(p.message) ?? string(record.message);
      if (text)
        emit("assistant", text, `summary:${locator.line_number}`, "summary");
      else coverage = "metadata";
    } else {
      coverage = "unknown";
      warnings.push(`unknown_record_type:${type ?? "missing"}`);
    }
  } else {
    const session = string(record.sessionId);
    if (session) {
      state.session_id =
        `${session}${state.agent_id ? `/${state.agent_id}` : ""}`.slice(0, 200);
      state.identity = "declared";
    }
    state.cwd = string(record.cwd) ?? state.cwd;
    if (string(record.version) && state.client_version !== record.version) {
      state.client_version = string(record.version);
      warnings.push("unverified_client_version");
    }
    const eventId = string(record.uuid) ?? `line:${locator.line_number}`,
      parent = string(record.parentUuid);
    if (type === "user" || type === "assistant") {
      const message = object(record.message),
        content = message.content;
      emit(
        type === "user" ? "user" : "assistant",
        contentText(content, warnings),
        eventId,
        "message",
        parent,
      );
    } else if (type === "summary")
      emit(
        "assistant",
        string(record.summary) ?? "",
        eventId,
        "summary",
        parent,
      );
    else if (
      [
        "system",
        "progress",
        "queue-operation",
        "file-history-snapshot",
        "last-prompt",
        "pr-link",
        "custom-title",
        "agent-name",
        "agent-color",
      ].includes(type ?? "")
    )
      coverage = "metadata";
    else {
      coverage = "unknown";
      warnings.push(`unknown_record_type:${type ?? "missing"}`);
    }
  }
  if (state.identity === "filename_fallback")
    warnings.push("uncertain_session_identity");
  return { events, coverage, warnings: [...new Set(warnings)] };
}

export function defaultHistoryRoots(home = os.homedir()) {
  const codex = process.env.CODEX_HOME ?? path.join(home, ".codex"),
    claude = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  return [
    { adapter: "codex" as const, path: path.join(codex, "sessions") },
    { adapter: "codex" as const, path: path.join(codex, "archived_sessions") },
    { adapter: "claude" as const, path: path.join(claude, "projects") },
  ];
}
export const adapterCapabilities = {
  codex: {
    format: "codex-jsonl-v1",
    record_types: [
      "session_meta",
      "turn_context",
      "response_item",
      "event_msg",
      "compacted",
      "token_usage_record",
      "world_state",
    ],
    // Two authorized, read-only archived sessions; see the dated real-source
    // verification record. This does not certify every feature of this version.
    real_client_versions_verified: ["0.162.0-alpha.17.2"] as string[],
  },
  claude: {
    format: "claude-code-jsonl-v1",
    record_types: [
      "user",
      "assistant",
      "system",
      "summary",
      "progress",
      "file-history-snapshot",
      "queue-operation",
    ],
    real_client_versions_verified: [] as string[],
  },
};
