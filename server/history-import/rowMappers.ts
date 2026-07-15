import {
  HistoricalBaselineDraftSchema,
  HistoricalEventDraftSchema,
  HistoricalImportSessionSchema,
  type HistoricalBaselineDraft,
  type HistoricalEventDraft,
  type HistoricalImportSession,
} from '../../src/domain/history-import';
import { StorageCorruptionError } from './errors';

export interface HistoricalImportSessionRow {
  id: unknown;
  status: unknown;
  created_at: unknown;
  updated_at: unknown;
  confirmed_at: unknown;
  discarded_at: unknown;
  row_version: unknown;
}

export interface HistoricalBaselineDraftRow {
  id: unknown;
  session_id: unknown;
  company: unknown;
  role: unknown;
  city: unknown;
  actually_applied: unknown;
  applied_at: unknown;
  time_precision: unknown;
  channel: unknown;
  recruiting_entity_kind: unknown;
  recruiting_entity_name: unknown;
  contact_name: unknown;
  resume_version_id: unknown;
  highest_known_stage: unknown;
  source_confidence: unknown;
  evidence_level: unknown;
  notes: unknown;
  duplicate_of_draft_id: unknown;
  keep_as_independent_process: unknown;
  independent_process_reason: unknown;
  created_job_id: unknown;
  created_application_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  row_version: unknown;
}

export interface HistoricalEventDraftRow {
  id: unknown;
  baseline_draft_id: unknown;
  event_type: unknown;
  event_at: unknown;
  time_precision: unknown;
  actor: unknown;
  source_confidence: unknown;
  evidence_level: unknown;
  channel: unknown;
  reason_code: unknown;
  note: unknown;
  created_feedback_event_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  row_version: unknown;
}

function parseStored<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof StorageCorruptionError) throw error;
    throw new StorageCorruptionError(`${label} 存储记录未通过领域校验`, error);
  }
}

export function rowToHistoricalImportSession(row: HistoricalImportSessionRow): HistoricalImportSession {
  return parseStored('HistoricalImportSession', () => HistoricalImportSessionSchema.parse({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    discardedAt: row.discarded_at,
    rowVersion: row.row_version,
  }));
}

export function historicalImportSessionToParams(
  session: HistoricalImportSession,
): Record<string, unknown> {
  const record = HistoricalImportSessionSchema.parse(session);
  return {
    id: record.id,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    confirmedAt: record.confirmedAt,
    discardedAt: record.discardedAt,
    rowVersion: record.rowVersion,
  };
}

export function rowToHistoricalBaselineDraft(row: HistoricalBaselineDraftRow): HistoricalBaselineDraft {
  return parseStored('HistoricalBaselineDraft', () => HistoricalBaselineDraftSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    company: row.company,
    role: row.role,
    city: row.city,
    actuallyApplied: row.actually_applied === 1,
    appliedAt: row.applied_at,
    timePrecision: row.time_precision,
    channel: row.channel,
    recruitingEntityKind: row.recruiting_entity_kind,
    recruitingEntityName: row.recruiting_entity_name,
    contactName: row.contact_name,
    resumeVersionId: row.resume_version_id,
    highestKnownStage: row.highest_known_stage,
    sourceConfidence: row.source_confidence,
    evidenceLevel: row.evidence_level,
    notes: row.notes,
    duplicateOfDraftId: row.duplicate_of_draft_id,
    keepAsIndependentProcess: row.keep_as_independent_process === 1,
    independentProcessReason: row.independent_process_reason,
    createdJobId: row.created_job_id,
    createdApplicationId: row.created_application_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  }));
}

export function historicalBaselineDraftToParams(
  draft: HistoricalBaselineDraft,
): Record<string, unknown> {
  const record = HistoricalBaselineDraftSchema.parse(draft);
  return {
    id: record.id,
    sessionId: record.sessionId,
    company: record.company,
    role: record.role,
    city: record.city,
    actuallyApplied: record.actuallyApplied ? 1 : 0,
    appliedAt: record.appliedAt,
    timePrecision: record.timePrecision,
    channel: record.channel,
    recruitingEntityKind: record.recruitingEntityKind,
    recruitingEntityName: record.recruitingEntityName,
    contactName: record.contactName,
    resumeVersionId: record.resumeVersionId,
    highestKnownStage: record.highestKnownStage,
    sourceConfidence: record.sourceConfidence,
    evidenceLevel: record.evidenceLevel,
    notes: record.notes,
    duplicateOfDraftId: record.duplicateOfDraftId,
    keepAsIndependentProcess: record.keepAsIndependentProcess ? 1 : 0,
    independentProcessReason: record.independentProcessReason,
    createdJobId: record.createdJobId,
    createdApplicationId: record.createdApplicationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rowVersion: record.rowVersion,
  };
}

export function rowToHistoricalEventDraft(row: HistoricalEventDraftRow): HistoricalEventDraft {
  return parseStored('HistoricalEventDraft', () => HistoricalEventDraftSchema.parse({
    id: row.id,
    baselineDraftId: row.baseline_draft_id,
    eventType: row.event_type,
    eventAt: row.event_at,
    timePrecision: row.time_precision,
    actor: row.actor,
    sourceConfidence: row.source_confidence,
    evidenceLevel: row.evidence_level,
    channel: row.channel,
    reasonCode: row.reason_code,
    note: row.note,
    createdFeedbackEventId: row.created_feedback_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  }));
}

export function historicalEventDraftToParams(
  draft: HistoricalEventDraft,
): Record<string, unknown> {
  const record = HistoricalEventDraftSchema.parse(draft);
  return {
    id: record.id,
    baselineDraftId: record.baselineDraftId,
    eventType: record.eventType,
    eventAt: record.eventAt,
    timePrecision: record.timePrecision,
    actor: record.actor,
    sourceConfidence: record.sourceConfidence,
    evidenceLevel: record.evidenceLevel,
    channel: record.channel,
    reasonCode: record.reasonCode,
    note: record.note,
    createdFeedbackEventId: record.createdFeedbackEventId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rowVersion: record.rowVersion,
  };
}
