import type { Generated } from "kysely";
export interface ProjectRow {
  id: string;
  name: string;
  revision: number;
  metadata: string;
  created_at: string;
}
export interface TypeRow {
  id: string;
  name: string;
  normalized_name: string;
  definition: string;
  parent_id: string | null;
  revision: number;
  disposition: string;
  created_at: string;
}
export interface EntityRow {
  id: string;
  current_revision: number;
  disposition: string;
  title: string;
  mechanism: string;
  rating: string;
  search_text: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
}
export interface RevisionRow {
  entity_id: string;
  revision: number;
  payload: string;
  actor: string;
  reason: string;
  created_at: string;
}
export interface CandidateRow {
  id: string;
  kind: string;
  payload: string;
  reason: string;
  evidence: string;
  disposition: string;
  revision: number;
  actor: string;
  created_at: string;
}
export interface JobRow {
  id: string;
  kind: string;
  status: string;
  payload: string;
  result: string | null;
  owner_token: string | null;
  lease_until: number;
  attempts: number;
  created_at: string;
  updated_at: string;
}
export interface Schema {
  library_lock: { id: number; revision: number };
  projects: ProjectRow;
  project_locations: {
    location: string;
    project_id: string;
    repository_hint: string | null;
    reason: string;
    actor: string;
  };
  project_type_revisions: {
    project_id: string;
    revision: number;
    type_ids: string;
    reason: string;
    actor: string;
    created_at: string;
  };
  project_type_selections: {
    project_id: string;
    type_id: string;
    selection_revision: number;
  };
  types: TypeRow;
  type_aliases: { alias: string; type_id: string };
  type_revisions: RevisionRow;
  tags: { id: string; name: string; normalized_name: string };
  entity_tag_links: { entity_kind: string; entity_id: string; tag_id: string };
  bugs: EntityRow;
  standards: EntityRow;
  bug_revisions: RevisionRow;
  standard_revisions: RevisionRow;
  bug_types: { entity_id: string; type_id: string };
  standard_types: { entity_id: string; type_id: string };
  bug_contexts: {
    id: string;
    bug_id: string;
    project_id: string | null;
    payload: string;
    fingerprint: string;
  };
  bug_standard_links: {
    bug_id: string;
    standard_id: string;
    revision: number;
    payload: string;
    actor: string;
    reason: string;
    created_at: string;
  };
  bug_standard_link_revisions: {
    bug_id: string;
    standard_id: string;
    revision: number;
    payload: string;
    actor: string;
    reason: string;
    created_at: string;
  };
  knowledge_candidates: CandidateRow;
  entity_redirects: {
    entity_kind: string;
    old_id: string;
    target_id: string;
    reason: string;
    actor: string;
    created_at: string;
  };
  mutation_records: {
    idempotency_key: string;
    request_hash: string;
    response: string;
    actor: string;
    created_at: string;
  };
  request_reservations: {
    idempotency_key: string;
    request_hash: string;
    created_at: string;
  };
  history_discovery_issues: {
    root_id: string;
    path_hash: string;
    code: string;
    scan_id: string;
    observed_at: string;
  };
  source_roots: {
    id: string;
    adapter: string;
    path: string;
    exclusions: string;
    created_at: string;
  };
  source_sessions: {
    id: string;
    root_id: string;
    external_id: string;
    generation: string;
    source_path: string;
    metadata: string;
    coverage: string;
    created_at: string;
  };
  source_segments: {
    id: string;
    session_id: string;
    logical_key: string;
    content_hash: string;
    excerpt: string;
    context: string;
    analysis_version: string;
    privacy_version: string;
    created_at: string;
  };
  provenance_links: {
    id: string;
    entity_kind: string;
    entity_id: string;
    segment_id: string;
    payload: string;
    fingerprint: string;
  };
  history_event_receipts: { replay_key: string; segment_id: string };
  history_source_issues: {
    id: string;
    source_id: string;
    byte_start: number;
    byte_end: number;
    line_number: number;
    code: string;
    created_at: string;
  };
  jobs: JobRow;
  segment_tasks: {
    id: string;
    segment_id: string;
    analysis_version: string;
    status: string;
    owner_token: string | null;
    lease_until: number;
    attempts: number;
    result: string | null;
    updated_at: string;
  };
  checkpoints: {
    source_id: string;
    generation: string;
    read_offset: number;
    metadata: string;
    updated_at: string;
  };
  acceptance_plans: {
    id: string;
    project_id: string;
    snapshot: string;
    created_at: string;
  };
  change_snapshots: {
    id: string;
    project_id: string;
    snapshot: string;
    content_hash: string;
    created_at: string;
  };
  plan_items: {
    id: string;
    plan_id: string;
    standard_id: string;
    standard_revision: number;
    payload: string;
  };
  plan_selection_decisions: {
    plan_id: string;
    standard_id: string;
    payload: string;
  };
  acceptance_results: {
    id: string;
    plan_item_id: string;
    attempt_id: string;
    execution_id: Generated<string>;
    outcome: string;
    environment_hash: string;
    payload: string;
    actor: string;
    created_at: string;
  };
  evidence: {
    id: string;
    result_id: string;
    kind: string;
    object_key: string | null;
    content_hash: string | null;
    payload: string;
    created_at: string;
  };
  report_exports: {
    id: string;
    plan_id: string;
    payload: string;
    content_hash: string;
    created_at: string;
  };
  report_result_links: {
    report_id: string;
    plan_item_id: string;
    result_id: string | null;
  };
  embeddings: {
    entity_kind: string;
    entity_id: string;
    revision: number;
    model_id: string;
    dimensions: number;
    normalization_version: string;
    vector: string;
  };
}
