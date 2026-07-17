import type { SqliteDatabase } from '../db';

export const JOB_MEMORY_SCHEMA_V2_SQL = `
CREATE TABLE resume_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  source TEXT NOT NULL CHECK (source IN ('profile_snapshot', 'pasted_text', 'imported_file_text')),
  content_hash TEXT NOT NULL UNIQUE CHECK (length(trim(content_hash)) > 0),
  summary TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  archived_at INTEGER CHECK (
    archived_at IS NULL
    OR (typeof(archived_at) = 'integer' AND archived_at >= created_at)
  ),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(row_version) = 'integer' AND row_version >= 1
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0)
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  resume_version_id TEXT REFERENCES resume_versions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('outbound', 'inbound', 'unknown')),
  channel TEXT NOT NULL CHECK (
    channel IN ('boss', 'official_site', 'referral', 'headhunter', 'email', 'wechat', 'other', 'unknown')
  ),
  channel_other_label TEXT,
  job_city_snapshot TEXT,
  market_city TEXT,
  work_mode TEXT NOT NULL CHECK (work_mode IN ('onsite', 'hybrid', 'remote', 'unknown')),
  recruiting_entity_kind TEXT NOT NULL CHECK (
    recruiting_entity_kind IN (
      'direct_employer',
      'outsourcing_vendor',
      'staffing_agency',
      'headhunter',
      'unknown'
    )
  ),
  recruiting_entity_name TEXT,
  employer_group_key TEXT,
  end_client_name TEXT,
  primary_contact_json TEXT,
  draft_message_text TEXT,
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (
    typeof(updated_at) = 'integer' AND updated_at >= created_at
  ),
  voided_at INTEGER CHECK (
    voided_at IS NULL
    OR (typeof(voided_at) = 'integer' AND voided_at >= created_at)
  ),
  void_reason TEXT,
  superseded_by_application_id TEXT REFERENCES applications(id) ON DELETE RESTRICT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(row_version) = 'integer' AND row_version >= 1
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  migration_key TEXT UNIQUE,
  CHECK (
    (channel = 'other' AND channel_other_label IS NOT NULL AND length(trim(channel_other_label)) > 0)
    OR (channel <> 'other' AND channel_other_label IS NULL)
  ),
  CHECK (
    (voided_at IS NULL AND void_reason IS NULL)
    OR (
      voided_at IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(trim(void_reason)) > 0
    )
  ),
  CHECK (
    superseded_by_application_id IS NULL
    OR superseded_by_application_id <> id
  )
);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'application_created',
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
      'position_closed',
      'marked_stale',
      'legacy_status_imported',
      'application_metadata_corrected',
      'application_voided',
      'event_voided'
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
  recorded_by TEXT NOT NULL CHECK (recorded_by IN ('user', 'system_migration')),
  source_confidence TEXT NOT NULL CHECK (
    source_confidence IN ('exact', 'approximate', 'recalled', 'inferred')
  ),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('strong', 'medium', 'weak')),
  channel TEXT CHECK (
    channel IS NULL
    OR channel IN ('boss', 'official_site', 'referral', 'headhunter', 'email', 'wechat', 'other', 'unknown')
  ),
  note TEXT,
  reason_code TEXT,
  payload_json TEXT NOT NULL,
  target_event_id TEXT REFERENCES feedback_events(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
  CHECK (event_at IS NOT NULL OR time_precision = 'unknown'),
  CHECK (target_event_id IS NULL OR target_event_id <> id),
  CHECK (
    (event_type = 'event_voided' AND target_event_id IS NOT NULL)
    OR (event_type <> 'event_voided' AND target_event_id IS NULL)
  )
);

CREATE INDEX applications_job_idx
  ON applications(job_id, voided_at, updated_at DESC);
CREATE INDEX applications_resume_idx
  ON applications(resume_version_id);
CREATE INDEX applications_market_idx
  ON applications(market_city, channel, employer_group_key);
CREATE INDEX applications_superseded_idx
  ON applications(superseded_by_application_id);
CREATE INDEX feedback_events_application_time_idx
  ON feedback_events(application_id, event_at, created_at, id);
CREATE INDEX feedback_events_reason_idx
  ON feedback_events(reason_code, evidence_level);
CREATE INDEX feedback_events_target_idx
  ON feedback_events(target_event_id);
`;

export function createJobMemorySchemaV2(db: SqliteDatabase): void {
  db.exec(JOB_MEMORY_SCHEMA_V2_SQL);
}
