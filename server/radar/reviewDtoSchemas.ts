/**
 * V8-3 人工评审工作台 API 的严格 DTO 契约（Wave 6）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §三。
 *
 * 严格边界：
 * - 响应绝不含 Cookie/Token/securityId/完整页面 HTML/无限 raw metadata；
 * - JD 只给受限摘要（截断），来源只给规范化 URL + 域名；
 * - 关系 signals 经白名单 DTO 脱敏，不透传 signals_json；
 * - 写请求 reason 必填且限长，携带乐观并发期望状态。
 */
import { z } from 'zod';
import { RADAR_CANDIDATE_RELATION_STATUSES } from '../../src/domain/radar';
import { FieldChangeClassificationSchema, CommitDecisionTypeSchema } from './candidateChangeSet';

export const REVIEW_JD_EXCERPT_MAX = 280;
export const REVIEW_REASON_MAX = 500;
export const REVIEW_NOTE_MAX = 1000;
export const REVIEW_RELATION_LIST_MAX = 50;
/** 单条脱敏信号字段/值的最大长度与每关系信号条数上限（严格边界，绝不透传任意 JSON）。 */
export const REVIEW_SIGNAL_VALUE_MAX = 120;
export const REVIEW_SIGNAL_EXPLANATION_MAX = 200;
export const REVIEW_SIGNAL_MAX_COUNT = 20;
export const REVIEW_AUDIT_TIMELINE_MAX = 100;

/* ---------- 请求 DTO ---------- */

/** 关系裁决状态过滤（人工工作台默认只看 suspected_duplicate + needs_recheck）。 */
export const RelationListQuerySchema = z.strictObject({
  // 查询串里 statuses 可能是单值字符串或重复键数组；统一收敛为数组。
  statuses: z.preprocess(
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(z.enum(RADAR_CANDIDATE_RELATION_STATUSES)).max(5).optional(),
  ),
  limit: z.coerce.number().int().min(1).max(REVIEW_RELATION_LIST_MAX).optional(),
});
export type RelationListQuery = z.infer<typeof RelationListQuerySchema>;

const reason = z.string().trim().min(1).max(REVIEW_REASON_MAX);
const note = z.string().trim().min(1).max(REVIEW_NOTE_MAX).nullable().optional();

/** 人工裁决请求（乐观并发：expectedCurrentStatus 必填）。 */
export const AdjudicationRequestSchema = z.strictObject({
  relationId: z.string().trim().min(1).max(100),
  reason,
  expectedCurrentStatus: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  note: note,
});
export type AdjudicationRequest = z.infer<typeof AdjudicationRequestSchema>;

export const RECHECK_EVIDENCE_REASON_VALUES = [
  'new_material_version',
  'company_resolved_consistent',
  'new_stable_source_link',
  'external_identity_corrected',
  'user_reverted_decision',
] as const;

/** 请求重新确认（需新实质证据）。 */
export const RecheckRequestSchema = z.strictObject({
  relationId: z.string().trim().min(1).max(100),
  evidenceReason: z.enum(RECHECK_EVIDENCE_REASON_VALUES),
  reason,
  expectedCurrentStatus: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  note: note,
});
export type RecheckRequest = z.infer<typeof RecheckRequestSchema>;

/** 设置规则覆盖。 */
export const RuleOverrideSetRequestSchema = z.strictObject({
  assessmentId: z.string().trim().min(1).max(100),
  overriddenValue: z.enum(['pass', 'block']),
  reason,
  expectedOverrideState: z.enum(['none', 'pass', 'block']),
});
export type RuleOverrideSetRequest = z.infer<typeof RuleOverrideSetRequestSchema>;

/** 撤销规则覆盖（恢复默认）。 */
export const RuleOverrideRevertRequestSchema = z.strictObject({
  assessmentId: z.string().trim().min(1).max(100),
  reason,
  expectedOverrideState: z.enum(['none', 'pass', 'block']),
});
export type RuleOverrideRevertRequest = z.infer<typeof RuleOverrideRevertRequestSchema>;

/* ---------- 响应 DTO ---------- */

/** 脱敏后的候选摘要（八字段 + 受限 JD 摘要 + 规范化来源），绝不含敏感字段。 */
export const CandidateSummarySchema = z.strictObject({
  candidateId: z.string(),
  activeCandidateVersionId: z.string().nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  city: z.string().nullable(),
  salaryMinK: z.number().nullable(),
  salaryMaxK: z.number().nullable(),
  salaryPeriod: z.string().nullable(),
  experienceRequirement: z.string().nullable(),
  educationRequirement: z.string().nullable(),
  jdExcerpt: z.string(),
  normalizedSourceUrl: z.string().nullable(),
  sourceDomain: z.string().nullable(),
});
export type CandidateSummary = z.infer<typeof CandidateSummarySchema>;

export const ChangedFieldViewSchema = z.strictObject({
  fieldPath: z.string(),
  before: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  after: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  classification: FieldChangeClassificationSchema,
  reason: z.string(),
});
export type ChangedFieldView = z.infer<typeof ChangedFieldViewSchema>;

export const CandidateDecisionDetailSchema = z.strictObject({
  candidateId: z.string(),
  activeCandidateVersionId: z.string().nullable(),
  decisionType: CommitDecisionTypeSchema,
  analysisEligible: z.boolean(),
  blockingIssues: z.array(z.string()),
  needsConfirmation: z.array(z.string()),
  conflictReason: z.string().nullable(),
  changedFields: z.array(ChangedFieldViewSchema),
  latestSnapshotId: z.string().nullable(),
  currentVersion: CandidateSummarySchema.nullable(),
  previousVersion: CandidateSummarySchema.nullable(),
  sourceLinks: z.array(z.strictObject({
    sourceRecordId: z.string(),
    linkReason: z.string(),
    normalizedSourceUrl: z.string().nullable(),
  })),
});
export type CandidateDecisionDetail = z.infer<typeof CandidateDecisionDetailSchema>;

/**
 * 单条脱敏疑似重复信号：从 signals_json 安全解析、严格收窄。
 * 绝不透传完整 JD / Cookie / Token / securityId / 任意 JSON；字段与值均限长。
 */
export const DuplicateSignalSchema = z.strictObject({
  signalType: z.string().max(REVIEW_SIGNAL_VALUE_MAX),
  field: z.string().max(REVIEW_SIGNAL_VALUE_MAX),
  candidateAValue: z.union([z.string().max(REVIEW_SIGNAL_VALUE_MAX), z.number(), z.boolean(), z.null()]),
  candidateBValue: z.union([z.string().max(REVIEW_SIGNAL_VALUE_MAX), z.number(), z.boolean(), z.null()]),
  strength: z.number().min(0).max(1).nullable(),
  explanation: z.string().max(REVIEW_SIGNAL_EXPLANATION_MAX),
});
export type DuplicateSignal = z.infer<typeof DuplicateSignalSchema>;

/** signals 解析态：present（≥1 条）/ empty（signals_json 无可展示信号）/ corrupt（存在但非法）。 */
export const SIGNALS_STATES = ['present', 'empty', 'corrupt'] as const;
export const SignalsStateSchema = z.enum(SIGNALS_STATES);
export type SignalsState = z.infer<typeof SignalsStateSchema>;

/** 关系 signals 视图：结构化信号数组（≤20 条）+ 解析态 + 可选损坏原因。 */
export const RelationSignalsSchema = z.strictObject({
  state: SignalsStateSchema,
  signals: z.array(DuplicateSignalSchema).max(REVIEW_SIGNAL_MAX_COUNT),
  corruptReason: z.string().max(REVIEW_SIGNAL_EXPLANATION_MAX).nullable(),
});
export type RelationSignals = z.infer<typeof RelationSignalsSchema>;

export const RelationListItemSchema = z.strictObject({
  relationId: z.string(),
  candidateIdLow: z.string(),
  candidateIdHigh: z.string(),
  status: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  reasonCode: z.string().nullable(),
  signals: RelationSignalsSchema,
  firstDetectedAt: z.number(),
  lastDetectedAt: z.number(),
  lowSummary: CandidateSummarySchema,
  highSummary: CandidateSummarySchema,
  hasPriorDecision: z.boolean(),
});
export type RelationListItem = z.infer<typeof RelationListItemSchema>;

/** 关系裁决审计时间线条目：从既有 RadarAction 只读聚合，绝不改写旧事件。 */
export const RELATION_AUDIT_ACTION_TYPES = [
  'duplicate_confirmed',
  'duplicate_rejected',
  'duplicate_decision_reverted',
  'duplicate_recheck_requested',
] as const;
export const RelationAuditEntrySchema = z.strictObject({
  actionId: z.string(),
  actionType: z.enum(RELATION_AUDIT_ACTION_TYPES),
  reason: z.string().nullable(),
  evidenceReason: z.string().nullable(),
  previousStatus: z.enum(RADAR_CANDIDATE_RELATION_STATUSES).nullable(),
  resultingStatus: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  occurredAt: z.number(),
  reverted: z.boolean(),
});
export type RelationAuditEntry = z.infer<typeof RelationAuditEntrySchema>;

/** 关系详情：当前状态 + 原因码 + 用户裁决原因 + 时间 + signals + 两侧候选 + 审计时间线。 */
export const RelationDetailSchema = z.strictObject({
  relationId: z.string(),
  candidateIdLow: z.string(),
  candidateIdHigh: z.string(),
  status: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  reasonCode: z.string().nullable(),
  decisionReason: z.string().nullable(),
  signals: RelationSignalsSchema,
  firstDetectedAt: z.number(),
  lastDetectedAt: z.number(),
  decidedAt: z.number().nullable(),
  lowSummary: CandidateSummarySchema,
  highSummary: CandidateSummarySchema,
  auditTimeline: z.array(RelationAuditEntrySchema).max(REVIEW_AUDIT_TIMELINE_MAX),
});
export type RelationDetail = z.infer<typeof RelationDetailSchema>;

/** 决策审阅 feed 条目：覆盖有候选的 material/regression/ambiguous 与无候选的 identity_conflict。 */
export const DecisionFeedItemSchema = z.strictObject({
  snapshotId: z.string(),
  candidateId: z.string().nullable(),
  activeCandidateVersionId: z.string().nullable(),
  decisionType: CommitDecisionTypeSchema,
  analysisEligible: z.boolean(),
  blockingIssues: z.array(z.string()),
  needsConfirmation: z.array(z.string()),
  conflictReason: z.string().nullable(),
  changedFieldPaths: z.array(z.string()),
  summary: CandidateSummarySchema.nullable(),
});
export type DecisionFeedItem = z.infer<typeof DecisionFeedItemSchema>;

/** 规则覆盖审计条目：append-only，时间升序；不修改原 RuleAssessment。 */
export const OverrideAuditEntrySchema = z.strictObject({
  actionId: z.string(),
  actionType: z.enum(['rule_override_set', 'rule_override_reverted']),
  reason: z.string().nullable(),
  overriddenValue: z.enum(['pass', 'block']).nullable(),
  previousOverrideState: z.enum(['none', 'pass', 'block']),
  resultingOverrideState: z.enum(['none', 'pass', 'block']),
  occurredAt: z.number(),
  reverted: z.boolean(),
});
export type OverrideAuditEntry = z.infer<typeof OverrideAuditEntrySchema>;

export const RuleEvidenceViewSchema = z.strictObject({
  assessmentId: z.string(),
  ruleKey: z.string(),
  evidenceState: z.enum(['structured', 'legacy_scalar', 'corrupt']),
  corruptReason: z.string().nullable(),
  overrideState: z.enum(['none', 'pass', 'block']),
  // 原始规则评估只读标识（证明覆盖操作从不修改原评估）。
  originalResult: z.string(),
  evidenceHashShort: z.string().nullable(),
  overrideAudit: z.array(OverrideAuditEntrySchema).max(REVIEW_AUDIT_TIMELINE_MAX),
  // structured 时填充，legacy/corrupt 为 null。
  ruleId: z.string().nullable(),
  ruleVersion: z.string().nullable(),
  outcome: z.string().nullable(),
  matchedFieldPath: z.string().nullable(),
  rawValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  normalizedValue: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  excerpt: z.string().nullable(),
  explanation: z.string().nullable(),
  confidence: z.number().nullable(),
  blocking: z.boolean().nullable(),
  // legacy_scalar 回退字段。
  matchedText: z.string().nullable(),
});
export type RuleEvidenceView = z.infer<typeof RuleEvidenceViewSchema>;
