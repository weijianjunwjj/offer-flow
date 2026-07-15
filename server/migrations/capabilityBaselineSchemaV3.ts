import type { SqliteDatabase } from '../db';

/**
 * G2 能力基线正式持久化（schema v3）。
 * 纯新增表，不修改 v2 既有表与数据；候选证据、基线提案、正式版本与命令回执各自独立成表，
 * 不塞入 app_meta / profiles JSON / localStorage。
 */
export const CAPABILITY_BASELINE_SCHEMA_V3_SQL = `
CREATE TABLE capability_baseline_meta (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(state_version) = 'integer' AND state_version >= 0
  ),
  active_version_id TEXT,
  updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0)
);

CREATE TABLE candidate_evidence (
  id TEXT PRIMARY KEY,
  capability_key TEXT NOT NULL CHECK (length(trim(capability_key)) > 0),
  polarity TEXT NOT NULL CHECK (polarity IN ('support', 'counter', 'neutral')),
  strength TEXT NOT NULL CHECK (strength IN ('strong', 'medium', 'weak')),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('profile', 'resume_version', 'job', 'application', 'feedback_event', 'user_input')
  ),
  source_id TEXT,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('manual', 'ai', 'system')),
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred')
  ),
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE capability_baseline_proposals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'accepted', 'modified_and_accepted', 'rejected', 'deferred')
  ),
  generated_by TEXT NOT NULL CHECK (generated_by IN ('ai', 'manual')),
  input_fingerprint TEXT NOT NULL CHECK (length(trim(input_fingerprint)) > 0),
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE TABLE capability_baseline_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  proposal_id TEXT NOT NULL CHECK (length(trim(proposal_id)) > 0),
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  activated_at INTEGER NOT NULL CHECK (typeof(activated_at) = 'integer' AND activated_at >= 0)
);

CREATE TABLE capability_command_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  command_type TEXT NOT NULL CHECK (
    command_type IN (
      'manual_evidence', 'generate_evidence', 'accept_evidence', 'reject_evidence', 'defer_evidence',
      'manual_baseline_proposal', 'generate_baseline_proposal', 'accept_baseline_proposal',
      'reject_baseline_proposal', 'defer_baseline_proposal', 'activate_baseline_version'
    )
  ),
  target_id TEXT,
  result_id TEXT,
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE INDEX candidate_evidence_capability_idx
  ON candidate_evidence(capability_key, status, created_at);
CREATE INDEX capability_baseline_proposals_status_idx
  ON capability_baseline_proposals(status, created_at);
CREATE INDEX capability_baseline_versions_status_idx
  ON capability_baseline_versions(status, version);
`;

export function createCapabilityBaselineSchemaV3(db: SqliteDatabase): void {
  db.exec(CAPABILITY_BASELINE_SCHEMA_V3_SQL);
}
