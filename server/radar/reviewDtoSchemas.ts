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

/** 关系 signals 白名单脱敏视图：只保留少数保守布尔/短字符串信号。 */
export const RedactedSignalsSchema = z.strictObject({
  companyNameSimilar: z.boolean().optional(),
  roleTitleSimilar: z.boolean().optional(),
  sameSourceDomain: z.boolean().optional(),
  sameNormalizedUrlHost: z.boolean().optional(),
  reason: z.string().max(200).optional(),
});
export type RedactedSignals = z.infer<typeof RedactedSignalsSchema>;

export const RelationListItemSchema = z.strictObject({
  relationId: z.string(),
  candidateIdLow: z.string(),
  candidateIdHigh: z.string(),
  status: z.enum(RADAR_CANDIDATE_RELATION_STATUSES),
  reasonCode: z.string().nullable(),
  signals: RedactedSignalsSchema,
  firstDetectedAt: z.number(),
  lastDetectedAt: z.number(),
  lowSummary: CandidateSummarySchema,
  highSummary: CandidateSummarySchema,
  hasPriorDecision: z.boolean(),
});
export type RelationListItem = z.infer<typeof RelationListItemSchema>;

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

export const RuleEvidenceViewSchema = z.strictObject({
  assessmentId: z.string(),
  ruleKey: z.string(),
  evidenceState: z.enum(['structured', 'legacy_scalar', 'corrupt']),
  corruptReason: z.string().nullable(),
  overrideState: z.enum(['none', 'pass', 'block']),
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
