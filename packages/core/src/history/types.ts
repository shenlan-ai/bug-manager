export type HistoryAdapter = "codex" | "claude";
export interface Locator {
  byte_start: number;
  byte_end: number;
  line_number: number;
  char_start?: number;
  char_end?: number;
}
export interface HistoryEvent extends Locator {
  adapter: HistoryAdapter;
  session_id: string;
  event_id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  cwd?: string;
  parent_id?: string;
}
export interface AdapterState {
  session_id: string;
  identity: "declared" | "filename_fallback";
  cwd?: string;
  agent_id?: string;
  recent: Array<{ hash: string; origin: string; line: number }>;
  client_version?: string;
}
export interface NormalizedRecord {
  events: HistoryEvent[];
  coverage: "recognized" | "metadata" | "excluded" | "unknown";
  warnings: string[];
}
export interface HistorySegment {
  fingerprint: string;
  session_id: string;
  logical_key: string;
  content_hash: string;
  excerpt: string;
  context: string;
  event_ids: string[];
  ranges: Locator[];
  summary_hash: string;
  analysis_version: string;
  privacy_version: string;
  summary_version?: string;
  project_hints?: string[];
}
