import { canonical, hash, boundedText } from "../util.js";
import { invariant } from "../errors.js";
import type { HistoryEvent, HistorySegment } from "./types.js";
import { CURRENT_ANALYSIS_VERSION } from "./versions.js";

export interface SegmenterState {
  context: HistoryEvent[];
  summary: string;
  summary_hash: string;
  guidance_anchor?: HistoryEvent;
  pending?: HistoryEvent[];
}
const CONTEXT_EVENT_LIMIT = 8;
const CONTEXT_CHAR_LIMIT = 6000;

function retainContext(events: HistoryEvent[]): HistoryEvent[] {
  const retained: HistoryEvent[] = [];
  let chars = 0;
  for (
    let index = events.length - 1;
    index >= 0 && retained.length < CONTEXT_EVENT_LIMIT;
    index--
  ) {
    const event = events[index]!,
      text = boundedText(event.text, 2000, "end");
    if (retained.length && chars + text.length > CONTEXT_CHAR_LIMIT) continue;
    retained.unshift({ ...event, text });
    chars += text.length;
  }
  return retained;
}
export class ContextSegmenter {
  private pending: HistoryEvent[] = [];
  private length = 0;
  private state: SegmenterState;
  constructor(
    readonly maxChars = 6000,
    state?: SegmenterState,
    readonly analysisVersion = CURRENT_ANALYSIS_VERSION,
    readonly privacyVersion = "1",
  ) {
    invariant(
      maxChars >= 64,
      "invalid_segment_budget",
      "Segment size must be at least 64 characters",
    );
    this.state = state ?? { context: [], summary: "", summary_hash: hash("") };
    this.pending = state?.pending ?? [];
    this.length = this.pending.reduce((n, e) => n + e.text.length, 0);
  }
  push(event: HistoryEvent): HistorySegment[] {
    const result: HistorySegment[] = [];
    if (event.role === "user")
      this.state.guidance_anchor = { ...event, text: event.text };
    for (let start = 0; start < event.text.length;) {
      let end = Math.min(start + this.maxChars, event.text.length);
      const last = event.text.charCodeAt(end - 1);
      if (end < event.text.length && last >= 0xd800 && last <= 0xdbff) end--;
      const part = {
        ...event,
        char_start: start,
        char_end: end,
        event_id:
          event.text.length > this.maxChars
            ? `${event.event_id}:chars:${start}-${end}`
            : event.event_id,
        text: event.text.slice(start, end),
      };
      if (
        this.pending.length &&
        (this.length + part.text.length > this.maxChars ||
          this.pending[0]!.session_id !== part.session_id)
      ) {
        const segment = this.flush();
        if (segment) result.push(segment);
      }
      if (
        this.state.context[0] &&
        this.state.context[0].session_id !== part.session_id
      )
        this.state = { context: [], summary: "", summary_hash: hash("") };
      this.pending.push(part);
      this.length += part.text.length;
      start = end;
    }
    return result;
  }
  flush(): HistorySegment | undefined {
    if (!this.pending.length) return undefined;
    const events = this.pending,
      excerpt = events.map((e) => `[${e.role}] ${e.text}`).join("\n"),
      event_ids = events.map((e) => e.event_id),
      content_hash = hash(excerpt),
      anchor = this.state.guidance_anchor,
      contextEvents =
        anchor &&
        !events.some(
          (event) =>
            event.event_id === anchor.event_id ||
            event.event_id.startsWith(`${anchor.event_id}:chars:`),
        )
          ? [
              {
                ...anchor,
                text: boundedText(anchor.text, 2000, "start"),
              },
              ...this.state.context,
            ]
          : this.state.context;
    const logical_key = `${event_ids[0]}..${event_ids.at(-1)}`;
    const segment: HistorySegment = {
      fingerprint: hash(
        canonical({
          adapter: events[0]!.adapter,
          session: events[0]!.session_id,
          event_ids,
          content_hash,
          analysis: this.analysisVersion,
          privacy: this.privacyVersion,
        }),
      ),
      session_id: events[0]!.session_id,
      logical_key,
      content_hash,
      excerpt,
      context: canonical({
        kind: "extractive_context",
        summary: this.state.summary,
        events: contextEvents.map((e) => ({
          role: e.role,
          event_id: e.event_id,
          text: boundedText(e.text, 2000, "end"),
        })),
      }),
      event_ids,
      ranges: events.map(
        ({ byte_start, byte_end, line_number, char_start, char_end }) => ({
          byte_start,
          byte_end,
          line_number,
          char_start,
          char_end,
        }),
      ),
      summary_hash: this.state.summary_hash,
      summary_version: "extractive-v1",
      project_hints: [
        ...new Set(events.flatMap((e) => (e.cwd ? [e.cwd] : []))),
      ],
      analysis_version: this.analysisVersion,
      privacy_version: this.privacyVersion,
    };
    const summary = boundedText(
      this.state.summary + "\n" + excerpt,
      2000,
      "end",
    );
    this.state = {
      context: retainContext(events),
      summary,
      summary_hash: hash(
        canonical({ previous: this.state.summary_hash, content_hash, summary }),
      ),
      guidance_anchor: this.state.guidance_anchor,
    };
    this.pending = [];
    this.length = 0;
    return segment;
  }
  checkpoint(): SegmenterState {
    return JSON.parse(
      canonical({ ...this.state, pending: this.pending }),
    ) as SegmenterState;
  }
}
