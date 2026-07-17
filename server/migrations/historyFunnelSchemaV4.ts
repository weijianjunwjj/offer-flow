import type { SqliteDatabase } from '../db';

/**
 * G3 历史补录与基础漏斗（schema v4）。
 * 纯新增表，不修改 v1-v3 既有表与数据；补录会话/草稿/事件草稿/确认回执各自独立成表，
 * 不塞入 app_meta / localStorage，也不为漏斗新增“漂移的统计副本”表——
 * 基础漏斗在查询时直接读取正式 applications / feedback_events 投影计算。
 */
export const HISTORY_FUNNEL_SCHEMA_V4_SQL = `
CREATE TABLE historical_import_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'preview_generated', 'confirmed', 'discarded')
  ),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  confirmed_at INTEGER CHECK (
    confirmed_at IS NULL
    OR (typeof(confirmed_at) = 'integer' AND confirmed_at >= created_at)
  ),
  discarded_at INTEGER CHECK (
    discarded_at IS NULL
    OR (typeof(discarded_at) = 'integer' AND discarded_at >= created_at)
  ),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(row_version) = 'integer' AND row_version >= 1
  ),
  CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
  CHECK (status <> 'discarded' OR discarded_at IS NOT NULL),
  CHECK (confirmed_at IS NULL OR discarded_at IS NULL)
);

CREATE TABLE historical_baseline_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES historical_import_sessions(id) ON DELETE CASCADE,
  company TEXT NOT NULL CHECK (length(trim(company)) > 0),
  role TEXT NOT NULL CHECK (length(trim(role)) > 0),
  city TEXT,
  actually_applied INTEGER NOT NULL CHECK (actually_applied IN (0, 1)),
  applied_at INTEGER CHECK (
    applied_at IS NULL
    OR (typeof(applied_at) = 'integer' AND applied_at >= 0)
  ),
  time_precision TEXT NOT NULL CHECK (
    time_precision IN ('exact', 'date', 'approximate', 'unknown')
  ),
  channel TEXT NOT NULL CHECK (
    channel IN ('boss', 'official_site', 'referral', 'headhunter', 'email', 'wechat', 'other', 'unknown')
  ),
  recruiting_entity_kind TEXT NOT NULL CHECK (
    recruiting_entity_kind IN (
      'direct_employer', 'outsourcing_vendor', 'staffing_agency', 'headhunter', 'unknown'
    )
  ),
  recruiting_entity_name TEXT,
  contact_name TEXT,
  resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE RESTRICT,
  highest_known_stage TEXT,
  source_confidence TEXT NOT NULL DEFAULT 'recalled' CHECK (
    source_confidence IN ('exact', 'approximate', 'recalled', 'inferred')
  ),
  evidence_level TEXT NOT NULL DEFAULT 'weak' CHECK (evidence_level IN ('strong', 'medium', 'weak')),
  notes TEXT,
  duplicate_of_draft_id TEXT REFERENCES historical_baseline_drafts(id) ON DELETE SET NULL,
  keep_as_independent_process INTEGER NOT NULL DEFAULT 0 CHECK (keep_as_independent_process IN (0, 1)),
  independent_process_reason TEXT,
  created_job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
  created_application_id TEXT REFERENCES applications(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(row_version) = 'integer' AND row_version >= 1
  ),
  CHECK (applied_at IS NOT NULL OR time_precision = 'unknown'),
  CHECK (duplicate_of_draft_id IS NULL OR duplicate_of_draft_id <> id),
  CHECK (
    (keep_as_independent_process = 0 AND independent_process_reason IS NULL)
    OR (
      keep_as_independent_process = 1
      AND independent_process_reason IS NOT NULL
      AND length(trim(independent_process_reason)) > 0
    )
  ),
  CHECK (
    (actually_applied = 1)
    OR (created_application_id IS NULL)
  )
);

CREATE TABLE historical_event_drafts (
  id TEXT PRIMARY KEY,
  baseline_draft_id TEXT NOT NULL REFERENCES historical_baseline_drafts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'applied',
      'hr_contacted',
      'greeting_sent',
      'message_viewed',
      'hr_replied',
      'resume_requested',
      'phone_screen',
      'interview_scheduled',
      'interview_completed',
      'interview_advanced',
      'follow_up_sent',
      'no_response_recorded',
      'rejected',
      'user_withdrew',
      'offer_received',
      'offer_declined',
      'offer_accepted',
      'recruitment_paused',
      'recruitment_frozen',
      'process_resumed',
      'position_closed'
    )
  ),
  event_at INTEGER CHECK (
    event_at IS NULL
    OR (typeof(event_at) = 'integer' AND event_at >= 0)
  ),
  time_precision TEXT NOT NULL CHECK (
    time_precision IN ('exact', 'date', 'approximate', 'unknown')
  ),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'hr', 'interviewer', 'recruiter', 'system')),
  source_confidence TEXT NOT NULL CHECK (
    source_confidence IN ('exact', 'approximate', 'recalled', 'inferred')
  ),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('strong', 'medium', 'weak')),
  channel TEXT CHECK (
    channel IS NULL
    OR channel IN ('boss', 'official_site', 'referral', 'headhunter', 'email', 'wechat', 'other', 'unknown')
  ),
  reason_code TEXT,
  note TEXT,
  created_feedback_event_id TEXT REFERENCES feedback_events(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(row_version) = 'integer' AND row_version >= 1
  ),
  CHECK (event_at IS NOT NULL OR time_precision = 'unknown')
);

CREATE TABLE historical_import_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  session_id TEXT NOT NULL REFERENCES historical_import_sessions(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)
);

CREATE INDEX historical_baseline_drafts_session_idx
  ON historical_baseline_drafts(session_id, updated_at DESC);
CREATE INDEX historical_baseline_drafts_duplicate_idx
  ON historical_baseline_drafts(duplicate_of_draft_id);
CREATE INDEX historical_event_drafts_baseline_idx
  ON historical_event_drafts(baseline_draft_id, event_at, created_at, id);
CREATE INDEX historical_import_receipts_session_idx
  ON historical_import_receipts(session_id);
`;

export function createHistoryFunnelSchemaV4(db: SqliteDatabase): void {
  db.exec(HISTORY_FUNNEL_SCHEMA_V4_SQL);
}
