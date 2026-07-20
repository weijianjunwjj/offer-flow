import type { SqliteDatabase } from '../db';

/**
 * v0.8 雷达领域全量 schema（v7，仅限沙箱/演练库）。
 * 纯新增 12 张表，不修改 v1-v6 既有表与数据。
 * active_version_id 在 radar_candidates 中允许 NULL，以支持事务内"先建 candidate、
 * 再建 version、最后更新 active_version_id"的三步原子流程；生命周期 active 时的
 * 非空性由 Repository 层保证，不在 SQLite 层强制（避免鸡蛋问题）。
 */
export const RADAR_DOMAIN_SCHEMA_V7_SQL = `
CREATE TABLE radar_capture_sessions (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('browser', 'pasted_text', 'shared_link_and_text', 'json')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('preview', 'committed', 'cancelled', 'expired')
  ),
  raw_input_json TEXT NOT NULL,
  preview_items_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at >= 0),
  committed_at INTEGER CHECK (
    committed_at IS NULL
    OR (typeof(committed_at) = 'integer' AND committed_at >= 0)
  ),
  CHECK (
    (status = 'committed' AND committed_at IS NOT NULL)
    OR (status <> 'committed' AND committed_at IS NULL)
  )
);

CREATE TABLE radar_capture_snapshots (
  id TEXT PRIMARY KEY,
  capture_session_id TEXT REFERENCES radar_capture_sessions(id) ON DELETE SET NULL,
  capture_method TEXT NOT NULL CHECK (
    capture_method IN (
      'boss_current_page', 'generic_visible_text',
      'pasted_text', 'shared_link_and_text', 'json_import'
    )
  ),
  provider_key TEXT,
  provider_version TEXT,
  source_domain TEXT,
  source_url TEXT,
  normalized_source_url TEXT,
  external_record_id TEXT,
  page_title TEXT,
  visible_text TEXT NOT NULL,
  raw_snapshot_json TEXT NOT NULL,
  raw_content_hash TEXT NOT NULL CHECK (length(trim(raw_content_hash)) > 0),
  captured_at INTEGER NOT NULL CHECK (typeof(captured_at) = 'integer' AND captured_at >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE radar_source_records (
  id TEXT PRIMARY KEY,
  provider_key TEXT,
  external_record_id TEXT,
  normalized_source_url TEXT,
  first_seen_at INTEGER NOT NULL CHECK (typeof(first_seen_at) = 'integer' AND first_seen_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (typeof(last_seen_at) = 'integer' AND last_seen_at >= 0),
  last_changed_at INTEGER CHECK (
    last_changed_at IS NULL
    OR (typeof(last_changed_at) = 'integer' AND last_changed_at >= 0)
  ),
  latest_snapshot_id TEXT NOT NULL REFERENCES radar_capture_snapshots(id) ON DELETE RESTRICT,
  source_status TEXT NOT NULL CHECK (source_status IN ('active', 'unknown')),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  UNIQUE (provider_key, external_record_id)
);

CREATE TABLE radar_candidates (
  id TEXT PRIMARY KEY,
  primary_source_record_id TEXT REFERENCES radar_source_records(id) ON DELETE RESTRICT,
  active_version_id TEXT REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('active', 'merged', 'archived')
  ),
  merged_into_candidate_id TEXT REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  CHECK (lifecycle_status <> 'merged' OR merged_into_candidate_id IS NOT NULL),
  CHECK (lifecycle_status <> 'active' OR merged_into_candidate_id IS NULL),
  CHECK (merged_into_candidate_id IS NULL OR merged_into_candidate_id <> id)
);

CREATE TABLE radar_candidate_versions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK (typeof(version_no) = 'integer' AND version_no >= 1),
  normalized_json TEXT NOT NULL,
  quality_issues_json TEXT NOT NULL,
  source_snapshot_ids_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  origin_type TEXT NOT NULL CHECK (
    origin_type IN ('captured', 'manual_correction', 'source_change', 'merge_resolution')
  ),
  correction_note TEXT,
  supersedes_version_id TEXT REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  UNIQUE (candidate_id, version_no),
  UNIQUE (candidate_id, content_hash),
  CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> id)
);

CREATE TABLE radar_candidate_sources (
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  source_record_id TEXT NOT NULL REFERENCES radar_source_records(id) ON DELETE RESTRICT,
  first_linked_at INTEGER NOT NULL CHECK (typeof(first_linked_at) = 'integer' AND first_linked_at >= 0),
  last_confirmed_at INTEGER NOT NULL CHECK (
    typeof(last_confirmed_at) = 'integer' AND last_confirmed_at >= 0
  ),
  link_reason TEXT NOT NULL CHECK (
    link_reason IN ('primary', 'confirmed_duplicate', 'probable_confirmed', 'manual')
  ),
  PRIMARY KEY (candidate_id, source_record_id)
);

CREATE TABLE radar_rule_assessments (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_version_id TEXT NOT NULL REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
  rule_key TEXT NOT NULL CHECK (length(trim(rule_key)) > 0),
  category TEXT NOT NULL CHECK (
    category IN ('hard_constraint', 'risk', 'preference', 'state_suppression')
  ),
  severity TEXT NOT NULL CHECK (length(trim(severity)) > 0),
  result TEXT NOT NULL CHECK (result IN ('hit', 'pass', 'unknown')),
  matched_text TEXT,
  source_path TEXT,
  explanation TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE analysis_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL CHECK (
    task_type IN ('job_match_analysis', 'recommendation_batch')
  ),
  entity_type TEXT NOT NULL CHECK (length(trim(entity_type)) > 0),
  entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  input_hash TEXT NOT NULL CHECK (length(trim(input_hash)) > 0),
  input_snapshot_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(attempt_count) = 'integer' AND attempt_count >= 0
  ),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (
    typeof(max_attempts) = 'integer' AND max_attempts >= 1
  ),
  started_at INTEGER CHECK (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at >= 0)),
  finished_at INTEGER CHECK (
    finished_at IS NULL OR (typeof(finished_at) = 'integer' AND finished_at >= 0)
  ),
  cancelled_at INTEGER CHECK (
    cancelled_at IS NULL OR (typeof(cancelled_at) = 'integer' AND cancelled_at >= 0)
  ),
  error_code TEXT,
  error_message TEXT,
  result_record_id TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
  CHECK (status <> 'queued' OR started_at IS NULL),
  CHECK (status NOT IN ('running', 'succeeded', 'failed', 'cancelled') OR started_at IS NOT NULL),
  CHECK (status NOT IN ('succeeded', 'failed') OR finished_at IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (status = 'succeeded' OR result_record_id IS NULL)
);

CREATE TABLE job_match_analysis_records (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_version_id TEXT NOT NULL REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  resume_version_id TEXT NOT NULL REFERENCES resume_versions(id) ON DELETE RESTRICT,
  job_match_profile_version_id TEXT NOT NULL CHECK (length(trim(job_match_profile_version_id)) > 0),
  city_code TEXT,
  capability_baseline_version_id TEXT,
  market_position_version_id TEXT,
  strategy_version_id TEXT,
  rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
  prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version)) > 0),
  analysis_policy_version TEXT NOT NULL CHECK (length(trim(analysis_policy_version)) > 0),
  model_provider TEXT NOT NULL CHECK (length(trim(model_provider)) > 0),
  model_name TEXT NOT NULL CHECK (length(trim(model_name)) > 0),
  model_version TEXT,
  input_hash TEXT NOT NULL UNIQUE CHECK (length(trim(input_hash)) > 0),
  recommendation TEXT NOT NULL CHECK (
    recommendation IN ('apply_now', 'stretch', 'verify', 'skip')
  ),
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  supersedes_analysis_id TEXT REFERENCES job_match_analysis_records(id) ON DELETE RESTRICT,
  CHECK (supersedes_analysis_id IS NULL OR supersedes_analysis_id <> id)
);

CREATE TABLE radar_recommendation_batches (
  id TEXT PRIMARY KEY,
  batch_key TEXT NOT NULL UNIQUE CHECK (length(trim(batch_key)) > 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  scope_json TEXT NOT NULL,
  candidate_version_ids_json TEXT NOT NULL,
  selected_candidate_version_ids_json TEXT NOT NULL,
  profile_versions_json TEXT NOT NULL,
  rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
  recommendation_rule_version TEXT NOT NULL CHECK (length(trim(recommendation_rule_version)) > 0),
  analysis_policy_version TEXT NOT NULL CHECK (length(trim(analysis_policy_version)) > 0),
  handled_state_hash TEXT NOT NULL CHECK (length(trim(handled_state_hash)) > 0),
  diagnosis_status TEXT NOT NULL CHECK (
    diagnosis_status IN ('formed', 'insufficient_evidence')
  ),
  diagnosis_payload_json TEXT,
  empty_reason TEXT,
  generated_at INTEGER NOT NULL CHECK (typeof(generated_at) = 'integer' AND generated_at >= 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE radar_actions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_version_id TEXT NOT NULL REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (
    action_type IN (
      'saved', 'unsaved', 'ignored', 'ignore_reverted',
      'marked_priority', 'priority_reverted',
      'marked_applied_pending', 'applied_pending_reverted',
      'rule_override_set', 'rule_override_reverted',
      'promotion_requested'
    )
  ),
  reason_code TEXT,
  reason_text TEXT,
  metadata_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
  reverted_by_action_id TEXT REFERENCES radar_actions(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (reverted_by_action_id IS NULL OR reverted_by_action_id <> id)
);

CREATE TABLE radar_promotions (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES radar_candidates(id) ON DELETE RESTRICT,
  candidate_version_id TEXT NOT NULL REFERENCES radar_candidate_versions(id) ON DELETE RESTRICT,
  promotion_type TEXT NOT NULL CHECK (
    promotion_type IN ('job_only', 'application', 'feedback')
  ),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  application_id TEXT REFERENCES applications(id) ON DELETE RESTRICT,
  feedback_event_id TEXT REFERENCES feedback_events(id) ON DELETE RESTRICT,
  trigger_action_id TEXT REFERENCES radar_actions(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (
    (promotion_type = 'job_only' AND application_id IS NULL AND feedback_event_id IS NULL)
    OR (promotion_type = 'application' AND application_id IS NOT NULL AND feedback_event_id IS NULL)
    OR (promotion_type = 'feedback' AND application_id IS NOT NULL AND feedback_event_id IS NOT NULL)
  )
);

CREATE INDEX radar_capture_snapshots_provider_idx
  ON radar_capture_snapshots(provider_key, external_record_id);
CREATE INDEX radar_capture_snapshots_source_url_idx
  ON radar_capture_snapshots(normalized_source_url);
CREATE INDEX radar_capture_snapshots_content_hash_idx
  ON radar_capture_snapshots(raw_content_hash);
CREATE INDEX radar_capture_snapshots_captured_at_idx
  ON radar_capture_snapshots(captured_at);
CREATE INDEX radar_candidates_lifecycle_idx
  ON radar_candidates(lifecycle_status, updated_at DESC);
CREATE INDEX radar_candidate_versions_candidate_idx
  ON radar_candidate_versions(candidate_id, version_no DESC);
CREATE INDEX radar_rule_assessments_version_idx
  ON radar_rule_assessments(candidate_version_id, category, result);
CREATE INDEX analysis_tasks_entity_idx
  ON analysis_tasks(entity_type, entity_id, status);
CREATE INDEX analysis_tasks_status_idx
  ON analysis_tasks(status, created_at);
CREATE INDEX job_match_analysis_records_candidate_idx
  ON job_match_analysis_records(candidate_id, candidate_version_id, created_at DESC);
CREATE INDEX radar_actions_candidate_idx
  ON radar_actions(candidate_id, occurred_at DESC);
CREATE INDEX radar_promotions_candidate_idx
  ON radar_promotions(candidate_id, candidate_version_id);
`;

export function createRadarDomainSchemaV7(db: SqliteDatabase): void {
  db.exec(RADAR_DOMAIN_SCHEMA_V7_SQL);
}
