# Protocol examples

MCP calls use `{ "input": { ... }, "mutation": { "idempotency_key": "stable-request-key", "actor": "agent", "reason": "specific reason" } }`. Omit mutation for reads. Responses contain schema_version, request_id, data/warnings or error.code/message/retryable/details. On revision_conflict reread before editing; on cursor_stale restart the bounded query. Do not silently advance after an error.

Equivalent CLI invocation (JSON files avoid shell quoting errors):

```text
bug-manager --home <configured-data-directory> --json call analysis_submit --file proposal.json --actor agent --reason "Extract observed mechanism" --key <stable-request-key>
```

## Extraction

Claim with `{}` or an explicit segment_id; preserve task_id and owner_token. Request context with `{task_id, owner_token, type_ids: ["<uuid>"], query: "mechanism words", limit: 20}`. All angle-bracket IDs in examples are placeholders; actual IDs are UUIDs from prior responses.

Submit no findings as `{task_id, owner_token, outcome: "no_findings", reason: "No supported fault or preventive standard"}`. A proposal uses `outcome: "proposal"`, reason, retrieval_id, and proposal:

```json
{
  "standards": [{"ref": "standard", "record": {"...": "full standard schema"}}],
  "bugs": [{"ref": "bug", "record": {"...": "full Bug schema"}}],
  "links": [{"bug_ref": "bug", "standard_ref": "standard", "coverage_reason": "How the check detects the mechanism", "scenario_ids": ["repeat"]}]
}
```

Use live tool schema for records, confidence, provenance, contexts and coverage; the shortened extraction example is explanatory, not a runnable record. Existing edits supply id and expected_revision in addition to ref and the complete record. For reuse without editing, link using existing UUIDs. Confidence evidence excerpts quote the returned source or bounded neighbors, not invented summaries.

Every new Bug record includes `discovery`. For `origin: "human_reported"`, include the exact user message as `{role: "user", kind: "human_report", excerpt: "..."}`. For `origin: "human_guided_review"`, include both the user's explicit check request as `{role: "user", kind: "human_guidance", excerpt: "..."}` and the later in-scope result as `{role: "assistant"|"tool", kind: "agent_finding", excerpt: "..."}`. The service independently reloads the current or bounded neighboring segment, verifies the event role and excerpt, and requires guidance to precede the finding. An Agent-written or autonomously selected test is not a human source; record `no_findings`, and do not create a new standard solely from that failure.

## Result submission

This is the complete shape for a one-step scenario with a required log named effects. Replace IDs, hash, version and observations using the returned frozen plan and actual execution. Omitted scenario results remain not_run.

```json
{
  "plan_id": "<uuid>",
  "plan_item_id": "<uuid>",
  "standard_id": "<uuid>",
  "standard_revision": 1,
  "change_id": "<uuid>",
  "execution_id": "<uuid>",
  "attempt_id": "<uuid>",
  "environment": {
    "project_version": "<actual tested version>",
    "change_content_hash": "<64-character frozen change hash>",
    "platform": "<actual platform>",
    "tool_versions": {"test-runner": "<version>"}
  },
  "scenarios": [{
    "scenario_id": "repeat",
    "outcome": "passed",
    "observations": [{"step_index": 0, "expected": "One business effect", "actual": "<actual observation>"}],
    "evidence": [{
      "requirement_key": "effects",
      "kind": "log",
      "purpose": "Request and business effect counts",
      "collected_at": "2026-10-22T00:00:00Z",
      "media_type": "text/plain",
      "step_indexes": [0],
      "source": {"storage": "inbox", "path": "run-001/effects.log"}
    }]
  }]
}
```

Inbox paths are relative to `<evidence_dir>/inbox` and cannot traverse/symlink out. Inline source is `{storage: "inline", text: "necessary log excerpt"}`. External source is `{storage: "external", reference: "explicit reference"}`; its truth and availability are not checked. Non-passed scenarios require reason; empty scenarios submit an unexecuted attempt.

Create report with `{plan_id, execution_id}` or additionally `result_ids` for explicit selection. Read `acceptance_report_items` with cursor/limit, export with `{report_id, directory: "<new directory>"}`. Export success can include failed/I0-not_run results; return status represents the operation, never a release decision.
