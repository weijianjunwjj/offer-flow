import {
  AnalysisTaskSchema,
  JobMatchAnalysisRecordSchema,
  RadarActionSchema,
  RadarCandidateRelationSchema,
  RadarCandidateSchema,
  RadarCandidateSourceLinkSchema,
  RadarCandidateVersionSchema,
  RadarCaptureSessionSchema,
  RadarCaptureSnapshotSchema,
  RadarPromotionSchema,
  RadarRecommendationBatchSchema,
  RadarRuleAssessmentSchema,
  RadarSourceRecordSchema,
  type AnalysisTask,
  type JobMatchAnalysisRecord,
  type RadarAction,
  type RadarCandidate,
  type RadarCandidateRelation,
  type RadarCandidateSourceLink,
  type RadarCandidateVersion,
  type RadarCaptureSession,
  type RadarCaptureSnapshot,
  type RadarEvidenceLevel,
  type RadarPromotion,
  type RadarRecommendationBatch,
  type RadarRuleAssessment,
  type RadarSourceRecord,
} from '../../src/domain/radar';
import { RADAR_EVIDENCE_LEVELS } from '../../src/domain/radar';
import { parseJsonColumn, RadarStorageCorruptionError } from './errors';

function parseStored<T>(label: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof RadarStorageCorruptionError) throw error;
    throw new RadarStorageCorruptionError(`${label} 存储记录未通过领域校验`, error);
  }
}

export interface RadarCaptureSessionRow {
  id: unknown; source_type: unknown; status: unknown;
  raw_input_json: unknown; preview_items_json: unknown;
  created_at: unknown; expires_at: unknown; committed_at: unknown;
}

export function rowToRadarCaptureSession(row: RadarCaptureSessionRow): RadarCaptureSession {
  return parseStored('RadarCaptureSession', () => RadarCaptureSessionSchema.parse({
    id: row.id,
    sourceType: row.source_type,
    status: row.status,
    rawInput: parseJsonColumn('radar_capture_sessions.raw_input_json', row.raw_input_json),
    previewItems: parseJsonColumn('radar_capture_sessions.preview_items_json', row.preview_items_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    committedAt: row.committed_at,
  }));
}

export function radarCaptureSessionToParams(session: RadarCaptureSession): Record<string, unknown> {
  const record = RadarCaptureSessionSchema.parse(session);
  return {
    id: record.id,
    sourceType: record.sourceType,
    status: record.status,
    rawInputJson: JSON.stringify(record.rawInput),
    previewItemsJson: JSON.stringify(record.previewItems),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    committedAt: record.committedAt,
  };
}

export interface RadarCaptureSnapshotRow {
  id: unknown; capture_session_id: unknown; capture_method: unknown;
  provider_key: unknown; provider_version: unknown; source_domain: unknown;
  source_url: unknown; normalized_source_url: unknown; external_record_id: unknown;
  page_title: unknown; visible_text: unknown; raw_snapshot_json: unknown;
  raw_content_hash: unknown; captured_at: unknown; created_at: unknown;
}

export function rowToRadarCaptureSnapshot(row: RadarCaptureSnapshotRow): RadarCaptureSnapshot {
  return parseStored('RadarCaptureSnapshot', () => RadarCaptureSnapshotSchema.parse({
    id: row.id,
    captureSessionId: row.capture_session_id,
    captureMethod: row.capture_method,
    providerKey: row.provider_key,
    providerVersion: row.provider_version,
    sourceDomain: row.source_domain,
    sourceUrl: row.source_url,
    normalizedSourceUrl: row.normalized_source_url,
    externalRecordId: row.external_record_id,
    pageTitle: row.page_title,
    visibleText: row.visible_text,
    rawSnapshot: parseJsonColumn('radar_capture_snapshots.raw_snapshot_json', row.raw_snapshot_json),
    rawContentHash: row.raw_content_hash,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  }));
}

export function radarCaptureSnapshotToParams(snapshot: RadarCaptureSnapshot): Record<string, unknown> {
  const record = RadarCaptureSnapshotSchema.parse(snapshot);
  return {
    id: record.id,
    captureSessionId: record.captureSessionId,
    captureMethod: record.captureMethod,
    providerKey: record.providerKey,
    providerVersion: record.providerVersion,
    sourceDomain: record.sourceDomain,
    sourceUrl: record.sourceUrl,
    normalizedSourceUrl: record.normalizedSourceUrl,
    externalRecordId: record.externalRecordId,
    pageTitle: record.pageTitle,
    visibleText: record.visibleText,
    rawSnapshotJson: JSON.stringify(record.rawSnapshot),
    rawContentHash: record.rawContentHash,
    capturedAt: record.capturedAt,
    createdAt: record.createdAt,
  };
}

export interface RadarSourceRecordRow {
  id: unknown; provider_key: unknown; external_record_id: unknown;
  normalized_source_url: unknown; first_seen_at: unknown; last_seen_at: unknown;
  last_changed_at: unknown; latest_snapshot_id: unknown; source_status: unknown;
  created_at: unknown; updated_at: unknown;
}

export function rowToRadarSourceRecord(row: RadarSourceRecordRow): RadarSourceRecord {
  return parseStored('RadarSourceRecord', () => RadarSourceRecordSchema.parse({
    id: row.id,
    providerKey: row.provider_key,
    externalRecordId: row.external_record_id,
    normalizedSourceUrl: row.normalized_source_url,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    latestSnapshotId: row.latest_snapshot_id,
    sourceStatus: row.source_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function radarSourceRecordToParams(record: RadarSourceRecord): Record<string, unknown> {
  const parsed = RadarSourceRecordSchema.parse(record);
  return {
    id: parsed.id,
    providerKey: parsed.providerKey,
    externalRecordId: parsed.externalRecordId,
    normalizedSourceUrl: parsed.normalizedSourceUrl,
    firstSeenAt: parsed.firstSeenAt,
    lastSeenAt: parsed.lastSeenAt,
    lastChangedAt: parsed.lastChangedAt,
    latestSnapshotId: parsed.latestSnapshotId,
    sourceStatus: parsed.sourceStatus,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

export interface RadarCandidateRow {
  id: unknown; primary_source_record_id: unknown; active_version_id: unknown;
  lifecycle_status: unknown; merged_into_candidate_id: unknown;
  created_at: unknown; updated_at: unknown;
}

export function rowToRadarCandidate(row: RadarCandidateRow): RadarCandidate {
  return parseStored('RadarCandidate', () => RadarCandidateSchema.parse({
    id: row.id,
    primarySourceRecordId: row.primary_source_record_id,
    activeVersionId: row.active_version_id,
    lifecycleStatus: row.lifecycle_status,
    mergedIntoCandidateId: row.merged_into_candidate_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function radarCandidateToParams(candidate: RadarCandidate): Record<string, unknown> {
  const record = RadarCandidateSchema.parse(candidate);
  return {
    id: record.id,
    primarySourceRecordId: record.primarySourceRecordId,
    activeVersionId: record.activeVersionId,
    lifecycleStatus: record.lifecycleStatus,
    mergedIntoCandidateId: record.mergedIntoCandidateId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface RadarCandidateVersionRow {
  id: unknown; candidate_id: unknown; version_no: unknown;
  normalized_json: unknown; quality_issues_json: unknown; source_snapshot_ids_json: unknown;
  content_hash: unknown; origin_type: unknown; evidence_level?: unknown;
  correction_note: unknown;
  supersedes_version_id: unknown; created_at: unknown;
}

export function rowToRadarCandidateVersion(row: RadarCandidateVersionRow): RadarCandidateVersion {
  // evidence_level 可能不在 SELECT 列中（旧查询）或为 NULL（v0.8 旧数据）：
  // 一律映射为 'FULL_EVIDENCE'，与 schema DEFAULT 和 v0.8 语义一致。
  const evidenceLevel: RadarEvidenceLevel = (() => {
    const raw = row.evidence_level;
    if (raw === undefined || raw === null) return 'FULL_EVIDENCE';
    const val = String(raw);
    if ((RADAR_EVIDENCE_LEVELS as readonly string[]).includes(val)) {
      return val as RadarEvidenceLevel;
    }
    return 'FULL_EVIDENCE';
  })();

  return parseStored('RadarCandidateVersion', () => RadarCandidateVersionSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    versionNo: row.version_no,
    normalized: parseJsonColumn('radar_candidate_versions.normalized_json', row.normalized_json),
    qualityIssues: parseJsonColumn('radar_candidate_versions.quality_issues_json', row.quality_issues_json),
    sourceSnapshotIds: parseJsonColumn(
      'radar_candidate_versions.source_snapshot_ids_json', row.source_snapshot_ids_json,
    ),
    contentHash: row.content_hash,
    originType: row.origin_type,
    evidenceLevel,
    correctionNote: row.correction_note,
    supersedesVersionId: row.supersedes_version_id,
    createdAt: row.created_at,
  }));
}

export function radarCandidateVersionToParams(version: RadarCandidateVersion): Record<string, unknown> {
  const record = RadarCandidateVersionSchema.parse(version);
  return {
    id: record.id,
    candidateId: record.candidateId,
    versionNo: record.versionNo,
    normalizedJson: JSON.stringify(record.normalized),
    qualityIssuesJson: JSON.stringify(record.qualityIssues),
    sourceSnapshotIdsJson: JSON.stringify(record.sourceSnapshotIds),
    contentHash: record.contentHash,
    originType: record.originType,
    evidenceLevel: record.evidenceLevel,
    correctionNote: record.correctionNote,
    supersedesVersionId: record.supersedesVersionId,
    createdAt: record.createdAt,
  };
}

export interface RadarCandidateSourceLinkRow {
  candidate_id: unknown; source_record_id: unknown;
  first_linked_at: unknown; last_confirmed_at: unknown; link_reason: unknown;
}

export function rowToRadarCandidateSourceLink(row: RadarCandidateSourceLinkRow): RadarCandidateSourceLink {
  return parseStored('RadarCandidateSourceLink', () => RadarCandidateSourceLinkSchema.parse({
    candidateId: row.candidate_id,
    sourceRecordId: row.source_record_id,
    firstLinkedAt: row.first_linked_at,
    lastConfirmedAt: row.last_confirmed_at,
    linkReason: row.link_reason,
  }));
}

export function radarCandidateSourceLinkToParams(link: RadarCandidateSourceLink): Record<string, unknown> {
  const record = RadarCandidateSourceLinkSchema.parse(link);
  return {
    candidateId: record.candidateId,
    sourceRecordId: record.sourceRecordId,
    firstLinkedAt: record.firstLinkedAt,
    lastConfirmedAt: record.lastConfirmedAt,
    linkReason: record.linkReason,
  };
}

export interface RadarCandidateRelationRow {
  id: unknown; candidate_id_low: unknown; candidate_id_high: unknown; status: unknown;
  reason_code: unknown; signals_json: unknown; first_detected_at: unknown; last_detected_at: unknown;
  resolved_at: unknown; resolution_action_id: unknown; superseded_by_relation_id: unknown;
  created_at: unknown; updated_at: unknown;
}

export function rowToRadarCandidateRelation(row: RadarCandidateRelationRow): RadarCandidateRelation {
  return parseStored('RadarCandidateRelation', () => RadarCandidateRelationSchema.parse({
    id: row.id,
    candidateIdLow: row.candidate_id_low,
    candidateIdHigh: row.candidate_id_high,
    status: row.status,
    reasonCode: row.reason_code,
    signals: parseJsonColumn('radar_candidate_relations.signals_json', row.signals_json),
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    resolvedAt: row.resolved_at,
    resolutionActionId: row.resolution_action_id,
    supersededByRelationId: row.superseded_by_relation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function radarCandidateRelationToParams(relation: RadarCandidateRelation): Record<string, unknown> {
  const record = RadarCandidateRelationSchema.parse(relation);
  return {
    id: record.id,
    candidateIdLow: record.candidateIdLow,
    candidateIdHigh: record.candidateIdHigh,
    status: record.status,
    reasonCode: record.reasonCode,
    signalsJson: JSON.stringify(record.signals ?? null),
    firstDetectedAt: record.firstDetectedAt,
    lastDetectedAt: record.lastDetectedAt,
    resolvedAt: record.resolvedAt,
    resolutionActionId: record.resolutionActionId,
    supersededByRelationId: record.supersededByRelationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface RadarRuleAssessmentRow {
  id: unknown; candidate_id: unknown; candidate_version_id: unknown;
  rule_version: unknown; rule_key: unknown; category: unknown; severity: unknown;
  result: unknown; matched_text: unknown; source_path: unknown;
  explanation: unknown; evidence_json?: unknown; created_at: unknown;
}

export function rowToRadarRuleAssessment(row: RadarRuleAssessmentRow): RadarRuleAssessment {
  // evidence_json 可能不在 SELECT 列中（旧查询）或为 NULL（旧行）：一律映射为 null，
  // 由上层按契约优先解析 evidence_json、NULL 时回退 scalar 字段。
  const evidenceJson = row.evidence_json === undefined || row.evidence_json === null
    ? null
    : String(row.evidence_json);
  return parseStored('RadarRuleAssessment', () => RadarRuleAssessmentSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    candidateVersionId: row.candidate_version_id,
    ruleVersion: row.rule_version,
    ruleKey: row.rule_key,
    category: row.category,
    severity: row.severity,
    result: row.result,
    matchedText: row.matched_text,
    sourcePath: row.source_path,
    explanation: row.explanation,
    evidenceJson,
    createdAt: row.created_at,
  }));
}

export function radarRuleAssessmentToParams(assessment: RadarRuleAssessment): Record<string, unknown> {
  const record = RadarRuleAssessmentSchema.parse(assessment);
  return {
    id: record.id,
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    ruleVersion: record.ruleVersion,
    ruleKey: record.ruleKey,
    category: record.category,
    severity: record.severity,
    result: record.result,
    matchedText: record.matchedText,
    sourcePath: record.sourcePath,
    explanation: record.explanation,
    evidenceJson: record.evidenceJson,
    createdAt: record.createdAt,
  };
}

export interface AnalysisTaskRow {
  id: unknown; task_type: unknown; entity_type: unknown; entity_id: unknown; status: unknown;
  input_hash: unknown; input_snapshot_json: unknown; attempt_count: unknown; max_attempts: unknown;
  started_at: unknown; finished_at: unknown; cancelled_at: unknown;
  error_code: unknown; error_message: unknown; result_record_id: unknown;
  created_at: unknown; updated_at: unknown;
}

export function rowToAnalysisTask(row: AnalysisTaskRow): AnalysisTask {
  return parseStored('AnalysisTask', () => AnalysisTaskSchema.parse({
    id: row.id,
    taskType: row.task_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    inputHash: row.input_hash,
    inputSnapshot: parseJsonColumn('analysis_tasks.input_snapshot_json', row.input_snapshot_json),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelledAt: row.cancelled_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultRecordId: row.result_record_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function analysisTaskToParams(task: AnalysisTask): Record<string, unknown> {
  const record = AnalysisTaskSchema.parse(task);
  return {
    id: record.id,
    taskType: record.taskType,
    entityType: record.entityType,
    entityId: record.entityId,
    status: record.status,
    inputHash: record.inputHash,
    inputSnapshotJson: JSON.stringify(record.inputSnapshot),
    attemptCount: record.attemptCount,
    maxAttempts: record.maxAttempts,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    cancelledAt: record.cancelledAt,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    resultRecordId: record.resultRecordId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface JobMatchAnalysisRecordRow {
  id: unknown; candidate_id: unknown; candidate_version_id: unknown; resume_version_id: unknown;
  job_match_profile_version_id: unknown; city_code: unknown; capability_baseline_version_id: unknown;
  market_position_version_id: unknown; strategy_version_id: unknown; rule_version: unknown;
  prompt_version: unknown; analysis_policy_version: unknown; model_provider: unknown;
  model_name: unknown; model_version: unknown; input_hash: unknown; recommendation: unknown;
  confidence: unknown; payload_json: unknown; created_at: unknown; supersedes_analysis_id: unknown;
}

export function rowToJobMatchAnalysisRecord(row: JobMatchAnalysisRecordRow): JobMatchAnalysisRecord {
  return parseStored('JobMatchAnalysisRecord', () => JobMatchAnalysisRecordSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    candidateVersionId: row.candidate_version_id,
    resumeVersionId: row.resume_version_id,
    jobMatchProfileVersionId: row.job_match_profile_version_id,
    cityCode: row.city_code,
    capabilityBaselineVersionId: row.capability_baseline_version_id,
    marketPositionVersionId: row.market_position_version_id,
    strategyVersionId: row.strategy_version_id,
    ruleVersion: row.rule_version,
    promptVersion: row.prompt_version,
    analysisPolicyVersion: row.analysis_policy_version,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    modelVersion: row.model_version,
    inputHash: row.input_hash,
    recommendation: row.recommendation,
    confidence: row.confidence,
    payload: parseJsonColumn('job_match_analysis_records.payload_json', row.payload_json),
    createdAt: row.created_at,
    supersedesAnalysisId: row.supersedes_analysis_id,
  }));
}

export function jobMatchAnalysisRecordToParams(record: JobMatchAnalysisRecord): Record<string, unknown> {
  const parsed = JobMatchAnalysisRecordSchema.parse(record);
  return {
    id: parsed.id,
    candidateId: parsed.candidateId,
    candidateVersionId: parsed.candidateVersionId,
    resumeVersionId: parsed.resumeVersionId,
    jobMatchProfileVersionId: parsed.jobMatchProfileVersionId,
    cityCode: parsed.cityCode,
    capabilityBaselineVersionId: parsed.capabilityBaselineVersionId,
    marketPositionVersionId: parsed.marketPositionVersionId,
    strategyVersionId: parsed.strategyVersionId,
    ruleVersion: parsed.ruleVersion,
    promptVersion: parsed.promptVersion,
    analysisPolicyVersion: parsed.analysisPolicyVersion,
    modelProvider: parsed.modelProvider,
    modelName: parsed.modelName,
    modelVersion: parsed.modelVersion,
    inputHash: parsed.inputHash,
    recommendation: parsed.recommendation,
    confidence: parsed.confidence,
    payloadJson: JSON.stringify(parsed.payload),
    createdAt: parsed.createdAt,
    supersedesAnalysisId: parsed.supersedesAnalysisId,
  };
}

export interface RadarRecommendationBatchRow {
  id: unknown; batch_key: unknown; status: unknown; scope_json: unknown;
  candidate_version_ids_json: unknown; selected_candidate_version_ids_json: unknown;
  profile_versions_json: unknown; rule_version: unknown; recommendation_rule_version: unknown;
  analysis_policy_version: unknown; handled_state_hash: unknown; diagnosis_status: unknown;
  diagnosis_payload_json: unknown; empty_reason: unknown; generated_at: unknown; created_at: unknown;
}

export function rowToRadarRecommendationBatch(row: RadarRecommendationBatchRow): RadarRecommendationBatch {
  return parseStored('RadarRecommendationBatch', () => RadarRecommendationBatchSchema.parse({
    id: row.id,
    batchKey: row.batch_key,
    status: row.status,
    scope: parseJsonColumn('radar_recommendation_batches.scope_json', row.scope_json),
    candidateVersionIds: parseJsonColumn(
      'radar_recommendation_batches.candidate_version_ids_json', row.candidate_version_ids_json,
    ),
    selectedCandidateVersionIds: parseJsonColumn(
      'radar_recommendation_batches.selected_candidate_version_ids_json',
      row.selected_candidate_version_ids_json,
    ),
    profileVersions: parseJsonColumn(
      'radar_recommendation_batches.profile_versions_json', row.profile_versions_json,
    ),
    ruleVersion: row.rule_version,
    recommendationRuleVersion: row.recommendation_rule_version,
    analysisPolicyVersion: row.analysis_policy_version,
    handledStateHash: row.handled_state_hash,
    diagnosisStatus: row.diagnosis_status,
    diagnosisPayload: row.diagnosis_payload_json === null
      ? null
      : parseJsonColumn('radar_recommendation_batches.diagnosis_payload_json', row.diagnosis_payload_json),
    emptyReason: row.empty_reason,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
  }));
}

export function radarRecommendationBatchToParams(batch: RadarRecommendationBatch): Record<string, unknown> {
  const record = RadarRecommendationBatchSchema.parse(batch);
  return {
    id: record.id,
    batchKey: record.batchKey,
    status: record.status,
    scopeJson: JSON.stringify(record.scope),
    candidateVersionIdsJson: JSON.stringify(record.candidateVersionIds),
    selectedCandidateVersionIdsJson: JSON.stringify(record.selectedCandidateVersionIds),
    profileVersionsJson: JSON.stringify(record.profileVersions),
    ruleVersion: record.ruleVersion,
    recommendationRuleVersion: record.recommendationRuleVersion,
    analysisPolicyVersion: record.analysisPolicyVersion,
    handledStateHash: record.handledStateHash,
    diagnosisStatus: record.diagnosisStatus,
    diagnosisPayloadJson: record.diagnosisPayload === null ? null : JSON.stringify(record.diagnosisPayload),
    emptyReason: record.emptyReason,
    generatedAt: record.generatedAt,
    createdAt: record.createdAt,
  };
}

export interface RadarActionRow {
  id: unknown; candidate_id: unknown; candidate_version_id: unknown; action_type: unknown;
  reason_code: unknown; reason_text: unknown; metadata_json: unknown;
  occurred_at: unknown; reverted_by_action_id: unknown; created_at: unknown;
}

export function rowToRadarAction(row: RadarActionRow): RadarAction {
  return parseStored('RadarAction', () => RadarActionSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    candidateVersionId: row.candidate_version_id,
    actionType: row.action_type,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    metadata: parseJsonColumn('radar_actions.metadata_json', row.metadata_json),
    occurredAt: row.occurred_at,
    revertedByActionId: row.reverted_by_action_id,
    createdAt: row.created_at,
  }));
}

export function radarActionToParams(action: RadarAction): Record<string, unknown> {
  const record = RadarActionSchema.parse(action);
  return {
    id: record.id,
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    actionType: record.actionType,
    reasonCode: record.reasonCode,
    reasonText: record.reasonText,
    metadataJson: JSON.stringify(record.metadata),
    occurredAt: record.occurredAt,
    revertedByActionId: record.revertedByActionId,
    createdAt: record.createdAt,
  };
}

export interface RadarPromotionRow {
  id: unknown; candidate_id: unknown; candidate_version_id: unknown; promotion_type: unknown;
  job_id: unknown; application_id: unknown; feedback_event_id: unknown;
  trigger_action_id: unknown; idempotency_key: unknown; created_at: unknown;
}

export function rowToRadarPromotion(row: RadarPromotionRow): RadarPromotion {
  return parseStored('RadarPromotion', () => RadarPromotionSchema.parse({
    id: row.id,
    candidateId: row.candidate_id,
    candidateVersionId: row.candidate_version_id,
    promotionType: row.promotion_type,
    jobId: row.job_id,
    applicationId: row.application_id,
    feedbackEventId: row.feedback_event_id,
    triggerActionId: row.trigger_action_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  }));
}

export function radarPromotionToParams(promotion: RadarPromotion): Record<string, unknown> {
  const record = RadarPromotionSchema.parse(promotion);
  return {
    id: record.id,
    candidateId: record.candidateId,
    candidateVersionId: record.candidateVersionId,
    promotionType: record.promotionType,
    jobId: record.jobId,
    applicationId: record.applicationId,
    feedbackEventId: record.feedbackEventId,
    triggerActionId: record.triggerActionId,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
  };
}
