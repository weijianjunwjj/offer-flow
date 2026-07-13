import {
  ApplicationRecordSchema,
  ContactSnapshotSchema,
  FeedbackEventRecordSchema,
  ResumeContentSnapshotSchema,
  ResumeVersionRecordSchema,
  type ApplicationRecord,
  type ContactSnapshot,
  type FeedbackEventRecord,
  type ResumeContentSnapshot,
  type ResumeVersionRecord,
} from '../../src/domain/job-memory';
import { StorageCorruptionError } from './errors';

export interface StoredResumeVersion {
  record: ResumeVersionRecord;
  idempotencyKey: string;
  requestHash: string;
}

export interface StoredApplication {
  record: ApplicationRecord;
  idempotencyKey: string;
  requestHash: string;
  migrationKey: string | null;
}

export interface StoredFeedbackEvent {
  record: FeedbackEventRecord;
  requestHash: string;
}

export interface ResumeVersionRow {
  id: unknown;
  name: unknown;
  source: unknown;
  content_hash: unknown;
  summary: unknown;
  content_json: unknown;
  created_at: unknown;
  archived_at: unknown;
  row_version: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
}

export interface ApplicationRow {
  id: unknown;
  job_id: unknown;
  resume_version_id: unknown;
  origin: unknown;
  channel: unknown;
  channel_other_label: unknown;
  job_city_snapshot: unknown;
  market_city: unknown;
  work_mode: unknown;
  recruiting_entity_kind: unknown;
  recruiting_entity_name: unknown;
  employer_group_key: unknown;
  end_client_name: unknown;
  primary_contact_json: unknown;
  draft_message_text: unknown;
  created_at: unknown;
  updated_at: unknown;
  voided_at: unknown;
  void_reason: unknown;
  superseded_by_application_id: unknown;
  row_version: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  migration_key: unknown;
}

export interface FeedbackEventRow {
  id: unknown;
  application_id: unknown;
  event_type: unknown;
  event_at: unknown;
  time_precision: unknown;
  actor: unknown;
  recorded_by: unknown;
  source_confidence: unknown;
  evidence_level: unknown;
  channel: unknown;
  note: unknown;
  reason_code: unknown;
  payload_json: unknown;
  target_event_id: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  created_at: unknown;
}

function parseJsonColumn(column: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new StorageCorruptionError(`存储列 ${column} 不是 JSON 字符串`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StorageCorruptionError(`存储列 ${column} 包含非法 JSON`, error);
  }
}

function parseStored<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof StorageCorruptionError) throw error;
    throw new StorageCorruptionError(`${label} 存储记录未通过领域校验`, error);
  }
}

function requireString(column: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new StorageCorruptionError(`存储列 ${column} 不是字符串`);
  }
  return value;
}

function nullableString(column: string, value: unknown): string | null {
  if (value === null) return null;
  return requireString(column, value);
}

export function rowToResumeVersion(row: ResumeVersionRow): StoredResumeVersion {
  return parseStored('ResumeVersion', () => {
    const contentSnapshot = ResumeContentSnapshotSchema.parse(
      parseJsonColumn('resume_versions.content_json', row.content_json),
    ) as ResumeContentSnapshot;
    const record = ResumeVersionRecordSchema.parse({
      id: row.id,
      name: row.name,
      source: row.source,
      contentHash: row.content_hash,
      summary: row.summary,
      contentSnapshot,
      createdAt: row.created_at,
      archivedAt: row.archived_at,
      rowVersion: row.row_version,
    });
    return {
      record,
      idempotencyKey: requireString('resume_versions.idempotency_key', row.idempotency_key),
      requestHash: requireString('resume_versions.request_hash', row.request_hash),
    };
  });
}

export function resumeVersionToParams(stored: StoredResumeVersion): Record<string, unknown> {
  const record = ResumeVersionRecordSchema.parse(stored.record);
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    contentHash: record.contentHash,
    summary: record.summary,
    contentJson: JSON.stringify(ResumeContentSnapshotSchema.parse(record.contentSnapshot)),
    createdAt: record.createdAt,
    archivedAt: record.archivedAt,
    rowVersion: record.rowVersion,
    idempotencyKey: stored.idempotencyKey,
    requestHash: stored.requestHash,
  };
}

export function rowToApplication(row: ApplicationRow): StoredApplication {
  return parseStored('Application', () => {
    let primaryContact: ContactSnapshot | null = null;
    if (row.primary_contact_json !== null) {
      primaryContact = ContactSnapshotSchema.parse(
        parseJsonColumn('applications.primary_contact_json', row.primary_contact_json),
      );
    }
    const record = ApplicationRecordSchema.parse({
      id: row.id,
      jobId: row.job_id,
      resumeVersionId: row.resume_version_id,
      origin: row.origin,
      channel: row.channel,
      channelOtherLabel: row.channel_other_label,
      recruitingEntity: {
        kind: row.recruiting_entity_kind,
        name: row.recruiting_entity_name,
        employerGroupKey: row.employer_group_key,
        endClientName: row.end_client_name,
      },
      primaryContact,
      cityContext: {
        jobCity: row.job_city_snapshot,
        marketCity: row.market_city,
        workMode: row.work_mode,
      },
      draftMessageText: row.draft_message_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      voidedAt: row.voided_at,
      voidReason: row.void_reason,
      supersededByApplicationId: row.superseded_by_application_id,
      rowVersion: row.row_version,
    });
    return {
      record,
      idempotencyKey: requireString('applications.idempotency_key', row.idempotency_key),
      requestHash: requireString('applications.request_hash', row.request_hash),
      migrationKey: nullableString('applications.migration_key', row.migration_key),
    };
  });
}

export function applicationToParams(stored: StoredApplication): Record<string, unknown> {
  const record = ApplicationRecordSchema.parse(stored.record);
  return {
    id: record.id,
    jobId: record.jobId,
    resumeVersionId: record.resumeVersionId,
    origin: record.origin,
    channel: record.channel,
    channelOtherLabel: record.channelOtherLabel,
    jobCitySnapshot: record.cityContext.jobCity,
    marketCity: record.cityContext.marketCity,
    workMode: record.cityContext.workMode,
    recruitingEntityKind: record.recruitingEntity.kind,
    recruitingEntityName: record.recruitingEntity.name,
    employerGroupKey: record.recruitingEntity.employerGroupKey,
    endClientName: record.recruitingEntity.endClientName,
    primaryContactJson: record.primaryContact === null
      ? null
      : JSON.stringify(ContactSnapshotSchema.parse(record.primaryContact)),
    draftMessageText: record.draftMessageText,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    voidedAt: record.voidedAt,
    voidReason: record.voidReason,
    supersededByApplicationId: record.supersededByApplicationId,
    rowVersion: record.rowVersion,
    idempotencyKey: stored.idempotencyKey,
    requestHash: stored.requestHash,
    migrationKey: stored.migrationKey,
  };
}

export function rowToFeedbackEvent(row: FeedbackEventRow): StoredFeedbackEvent {
  return parseStored('FeedbackEvent', () => {
    const record = FeedbackEventRecordSchema.parse({
      id: row.id,
      applicationId: row.application_id,
      eventType: row.event_type,
      eventAt: row.event_at,
      timePrecision: row.time_precision,
      actor: row.actor,
      recordedBy: row.recorded_by,
      sourceConfidence: row.source_confidence,
      evidenceLevel: row.evidence_level,
      channel: row.channel,
      note: row.note,
      reasonCode: row.reason_code,
      payload: parseJsonColumn('feedback_events.payload_json', row.payload_json),
      targetEventId: row.target_event_id,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    }) as FeedbackEventRecord;
    return {
      record,
      requestHash: requireString('feedback_events.request_hash', row.request_hash),
    };
  });
}

export function feedbackEventToParams(stored: StoredFeedbackEvent): Record<string, unknown> {
  const record = FeedbackEventRecordSchema.parse(stored.record) as FeedbackEventRecord;
  return {
    id: record.id,
    applicationId: record.applicationId,
    eventType: record.eventType,
    eventAt: record.eventAt,
    timePrecision: record.timePrecision,
    actor: record.actor,
    recordedBy: record.recordedBy,
    sourceConfidence: record.sourceConfidence,
    evidenceLevel: record.evidenceLevel,
    channel: record.channel,
    note: record.note,
    reasonCode: record.reasonCode,
    payloadJson: JSON.stringify(record.payload),
    targetEventId: record.targetEventId,
    idempotencyKey: record.idempotencyKey,
    requestHash: stored.requestHash,
    createdAt: record.createdAt,
  };
}
