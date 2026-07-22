/** pasted_text/shared_link_and_text/json 仅保留为已落库枚举的 legacy compatibility；当前产品入口只创建 browser。 */
export const RADAR_CAPTURE_SOURCE_TYPES = ['browser', 'pasted_text', 'shared_link_and_text', 'json'] as const;
export type RadarCaptureSourceType = (typeof RADAR_CAPTURE_SOURCE_TYPES)[number];

export const RADAR_CAPTURE_SESSION_STATUSES = ['preview', 'committed', 'cancelled', 'expired'] as const;
export type RadarCaptureSessionStatus = (typeof RADAR_CAPTURE_SESSION_STATUSES)[number];

export const RADAR_CAPTURE_METHODS = [
  'boss_current_page',
  'generic_visible_text',
  // legacy compatibility：以下值不再由当前产品入口创建。
  'pasted_text',
  'shared_link_and_text',
  'json_import',
] as const;
export type RadarCaptureMethod = (typeof RADAR_CAPTURE_METHODS)[number];

export const RADAR_SOURCE_STATUSES = ['active', 'unknown'] as const;
export type RadarSourceStatus = (typeof RADAR_SOURCE_STATUSES)[number];

export const RADAR_CANDIDATE_LIFECYCLE_STATUSES = ['active', 'merged', 'archived'] as const;
export type RadarCandidateLifecycleStatus = (typeof RADAR_CANDIDATE_LIFECYCLE_STATUSES)[number];

export const RADAR_CANDIDATE_VERSION_ORIGIN_TYPES = [
  'captured',
  'manual_correction',
  'source_change',
  'merge_resolution',
] as const;
export type RadarCandidateVersionOriginType = (typeof RADAR_CANDIDATE_VERSION_ORIGIN_TYPES)[number];

export const RADAR_CANDIDATE_SOURCE_LINK_REASONS = [
  'primary',
  'confirmed_duplicate',
  'probable_confirmed',
  'manual',
] as const;
export type RadarCandidateSourceLinkReason = (typeof RADAR_CANDIDATE_SOURCE_LINK_REASONS)[number];

export const RADAR_RULE_CATEGORIES = ['hard_constraint', 'risk', 'preference', 'state_suppression'] as const;
export type RadarRuleCategory = (typeof RADAR_RULE_CATEGORIES)[number];

export const RADAR_RULE_RESULTS = ['hit', 'pass', 'unknown'] as const;
export type RadarRuleResult = (typeof RADAR_RULE_RESULTS)[number];

export const ANALYSIS_TASK_TYPES = ['job_match_analysis', 'recommendation_batch'] as const;
export type AnalysisTaskType = (typeof ANALYSIS_TASK_TYPES)[number];

export const ANALYSIS_TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type AnalysisTaskStatus = (typeof ANALYSIS_TASK_STATUSES)[number];

export const ANALYSIS_TASK_ERROR_CODES = [
  'INPUT_NOT_READY',
  'INPUT_STALE_BEFORE_START',
  'PROVIDER_TIMEOUT',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_RATE_LIMIT',
  'SCHEMA_INVALID',
  'STRUCTURE_REPAIR_FAILED',
  'CANCELLED_BY_USER',
  'PROCESS_RESTART_INTERRUPTED',
  'RESULT_WRITE_FAILED',
  'CONFIGURATION_ERROR',
] as const;
export type AnalysisTaskErrorCode = (typeof ANALYSIS_TASK_ERROR_CODES)[number];

export const JOB_MATCH_RECOMMENDATIONS = ['apply_now', 'stretch', 'verify', 'skip'] as const;
export type JobMatchRecommendation = (typeof JOB_MATCH_RECOMMENDATIONS)[number];

export const JOB_MATCH_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type JobMatchConfidence = (typeof JOB_MATCH_CONFIDENCES)[number];

export const RADAR_RECOMMENDATION_BATCH_STATUSES = ['succeeded', 'failed'] as const;
export type RadarRecommendationBatchStatus = (typeof RADAR_RECOMMENDATION_BATCH_STATUSES)[number];

export const RADAR_RECOMMENDATION_DIAGNOSIS_STATUSES = ['formed', 'insufficient_evidence'] as const;
export type RadarRecommendationDiagnosisStatus = (typeof RADAR_RECOMMENDATION_DIAGNOSIS_STATUSES)[number];

export const RADAR_ACTION_TYPES = [
  'saved',
  'unsaved',
  'ignored',
  'ignore_reverted',
  'marked_priority',
  'priority_reverted',
  'marked_applied_pending',
  'applied_pending_reverted',
  'rule_override_set',
  'rule_override_reverted',
  'promotion_requested',
] as const;
export type RadarActionType = (typeof RADAR_ACTION_TYPES)[number];

export const RADAR_PROMOTION_TYPES = ['job_only', 'application', 'feedback'] as const;
export type RadarPromotionType = (typeof RADAR_PROMOTION_TYPES)[number];

/** TD §5.1 标准字段；由 V8-3 标准化流程填充，V8-1 仅落地存储结构。 */
export interface RadarCandidateNormalized {
  company: string | null;
  role: string | null;
  city: string | null;
  district: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
  companySize: string | null;
  industry: string | null;
  jobNature: string | null;
  workMode: string | null;
  technicalStack: string[];
  responsibilities: string[];
  requirements: string[];
  publishedAt: number | null;
  rawDescription: string;
}

export interface RadarCandidateQualityIssue {
  field: string;
  issue: string;
}

export interface RadarCaptureSession {
  id: string;
  sourceType: RadarCaptureSourceType;
  status: RadarCaptureSessionStatus;
  rawInput: unknown;
  previewItems: unknown;
  createdAt: number;
  expiresAt: number;
  committedAt: number | null;
}

export interface RadarCaptureSnapshot {
  id: string;
  captureSessionId: string | null;
  captureMethod: RadarCaptureMethod;
  providerKey: string | null;
  providerVersion: string | null;
  sourceDomain: string | null;
  sourceUrl: string | null;
  normalizedSourceUrl: string | null;
  externalRecordId: string | null;
  pageTitle: string | null;
  visibleText: string;
  rawSnapshot: unknown;
  rawContentHash: string;
  capturedAt: number;
  createdAt: number;
}

export interface RadarSourceRecord {
  id: string;
  providerKey: string | null;
  externalRecordId: string | null;
  normalizedSourceUrl: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  lastChangedAt: number | null;
  latestSnapshotId: string;
  sourceStatus: RadarSourceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RadarCandidate {
  id: string;
  primarySourceRecordId: string | null;
  activeVersionId: string | null;
  lifecycleStatus: RadarCandidateLifecycleStatus;
  mergedIntoCandidateId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RadarCandidateVersion {
  id: string;
  candidateId: string;
  versionNo: number;
  normalized: RadarCandidateNormalized;
  qualityIssues: RadarCandidateQualityIssue[];
  sourceSnapshotIds: string[];
  contentHash: string;
  originType: RadarCandidateVersionOriginType;
  correctionNote: string | null;
  supersedesVersionId: string | null;
  createdAt: number;
}

export interface RadarCandidateSourceLink {
  candidateId: string;
  sourceRecordId: string;
  firstLinkedAt: number;
  lastConfirmedAt: number;
  linkReason: RadarCandidateSourceLinkReason;
}

export interface RadarRuleAssessment {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  ruleVersion: string;
  ruleKey: string;
  category: RadarRuleCategory;
  severity: string;
  result: RadarRuleResult;
  matchedText: string | null;
  sourcePath: string | null;
  explanation: string;
  /**
   * V8-3 / RC-06 权威规则证据（evidence_json 原文，未解析）。
   * 旧行为 null（回退到 matchedText/sourcePath/explanation）；新行写入合法 evidence_json。
   * 解析与校验由 ruleEvidenceContract 负责，domain 层只持有原文字符串。
   */
  evidenceJson: string | null;
  createdAt: number;
}

export interface AnalysisTask {
  id: string;
  taskType: AnalysisTaskType;
  entityType: string;
  entityId: string;
  status: AnalysisTaskStatus;
  inputHash: string;
  inputSnapshot: unknown;
  attemptCount: number;
  maxAttempts: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelledAt: number | null;
  errorCode: AnalysisTaskErrorCode | null;
  errorMessage: string | null;
  resultRecordId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * TD §4.9 服务端审计 Envelope。V8-1 只落地存储结构与元字段；
 * payload 的具体 AI Payload 形状（jobFacts/dimensions/...）由 V8-4 定义与校验，
 * 此处保持 unknown 以避免提前固化尚未实现的业务契约。
 */
export interface JobMatchAnalysisRecord {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  resumeVersionId: string;
  jobMatchProfileVersionId: string;
  cityCode: string | null;
  capabilityBaselineVersionId: string | null;
  marketPositionVersionId: string | null;
  strategyVersionId: string | null;
  ruleVersion: string;
  promptVersion: string;
  analysisPolicyVersion: string;
  modelProvider: string;
  modelName: string;
  modelVersion: string | null;
  inputHash: string;
  recommendation: JobMatchRecommendation;
  confidence: JobMatchConfidence;
  payload: unknown;
  createdAt: number;
  supersedesAnalysisId: string | null;
}

/** TD §4.10；diagnosisPayload 的具体形状由 V8-5 误区诊断定义，此处保持 unknown。 */
export interface RadarRecommendationBatch {
  id: string;
  batchKey: string;
  status: RadarRecommendationBatchStatus;
  scope: unknown;
  candidateVersionIds: string[];
  selectedCandidateVersionIds: string[];
  profileVersions: unknown;
  ruleVersion: string;
  recommendationRuleVersion: string;
  analysisPolicyVersion: string;
  handledStateHash: string;
  diagnosisStatus: RadarRecommendationDiagnosisStatus;
  diagnosisPayload: unknown | null;
  emptyReason: string | null;
  generatedAt: number;
  createdAt: number;
}

export interface RadarAction {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  actionType: RadarActionType;
  reasonCode: string | null;
  reasonText: string | null;
  metadata: unknown;
  occurredAt: number;
  revertedByActionId: string | null;
  createdAt: number;
}

export interface RadarPromotion {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  promotionType: RadarPromotionType;
  jobId: string;
  applicationId: string | null;
  feedbackEventId: string | null;
  triggerActionId: string | null;
  idempotencyKey: string;
  createdAt: number;
}
