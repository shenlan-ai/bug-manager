import { parseArgs } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  hash,
  initialAdapterState,
  normalizeHistoryRecord,
  readJsonl,
} from "@bug-manager/core";

// Opt-in, local-only verification. No content, filename, IDs or source hashes
// enter its shareable result; the sample must already be authorized.
const { values } = parseArgs({
  options: {
    adapter: { type: "string" },
    sample: { type: "string" },
    output: { type: "string" },
  },
});
if (
  !["codex", "claude"].includes(values.adapter) ||
  !values.sample ||
  !values.output
)
  throw new Error("Supply --adapter codex|claude --sample PATH --output PATH");
const info = await stat(values.sample);
if (!info.isFile() || info.size > 4 * 1024 * 1024)
  throw new Error("Use an authorized sample file of at most 4 MiB");
const before = hash(await readFile(values.sample));
const state = initialAdapterState(values.sample);
const recordTypes = {},
  coverage = {},
  roles = {},
  warnings = {},
  issues = {};
let records = 0,
  events = 0;
for await (const row of readJsonl(values.sample, {
  max_bytes: 4 * 1024 * 1024,
})) {
  if (row.kind !== "record") {
    issues[row.kind] = (issues[row.kind] ?? 0) + 1;
    continue;
  }
  records++;
  const raw = row.value;
  const kind = typeof raw?.type === "string" ? raw.type : "missing";
  // Report only record-type counters; do not echo arbitrary source values.
  const type = /^[a-z_/-]{1,80}$/i.test(kind) ? kind : "other";
  recordTypes[type] = (recordTypes[type] ?? 0) + 1;
  const normalized = normalizeHistoryRecord(values.adapter, raw, state, row);
  coverage[normalized.coverage] = (coverage[normalized.coverage] ?? 0) + 1;
  for (const warning of normalized.warnings) {
    const category = warning.split(":")[0];
    warnings[category] = (warnings[category] ?? 0) + 1;
  }
  for (const event of normalized.events) {
    events++;
    roles[event.role] = (roles[event.role] ?? 0) + 1;
  }
}
const sourceUnchanged = before === hash(await readFile(values.sample));
const passed =
  sourceUnchanged &&
  state.identity === "declared" &&
  events > 0 &&
  !coverage.unknown &&
  !Object.keys(issues).length;
const result = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  adapter: values.adapter,
  client_version: /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(
    state.client_version ?? "",
  )
    ? state.client_version
    : "not_declared",
  source_bytes: info.size,
  records,
  events,
  record_types: recordTypes,
  coverage,
  roles,
  warnings,
  issues,
  source_unchanged: sourceUnchanged,
  declared_session_identity: state.identity === "declared",
  status: passed ? "passed_textual_sample" : "coverage_gaps",
  limitation:
    "Local text/metadata sample verification only; excludes runtime snapshots, reasoning and binary content. Not a claim about every client feature or version.",
};
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
process.stdout.write(JSON.stringify(result) + "\n");
if (!passed) process.exitCode = 1;
