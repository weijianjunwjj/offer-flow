/**
 * V8-3 字段级变化集合契约（changedFields）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §6/§8。
 *
 * 严格边界（§八）：
 * - before/after 使用受限 JSON-safe 值（复用规则证据的受限值语义，拒绝无限递归）；
 * - 不复制完整 JD、不含 Cookie/Token/securityId；
 * - 数量上限保护；
 * - 优先存入既有 CandidateVersion JSON 载体 / commit 决策摘要，不新增实体列、不塞 correction_note。
 */
import { z } from 'zod';
import { RestrictedJsonValueSchema } from './ruleEvidenceContract';

export const CHANGE_SET_CONTRACT_VERSION = 1;
export const CHANGE_SET_MAX_FIELDS = 40;

/** 字段变化分类（§八）。 */
export const FieldChangeClassificationSchema = z.enum([
  'added_fact',
  'removed_fact',
  'changed_fact',
  'formatting_only',
  'snapshot_only',
  'extraction_regression',
  'ambiguous',
]);

export type FieldChangeClassification = z.infer<typeof FieldChangeClassificationSchema>;

export const FieldChangeEntrySchema = z.strictObject({
  fieldPath: z.string().trim().min(1).max(200),
  before: RestrictedJsonValueSchema.nullable().default(null),
  after: RestrictedJsonValueSchema.nullable().default(null),
  classification: FieldChangeClassificationSchema,
  reason: z.string().trim().min(1).max(300),
  sourceSnapshotId: z.string().trim().min(1).max(100).nullable().default(null),
  confidence: z.number().finite().min(0).max(1).nullable().default(null),
});

export type FieldChangeEntry = z.infer<typeof FieldChangeEntrySchema>;

/** commit 决策类型（§四）。 */
export const CommitDecisionTypeSchema = z.enum([
  'new_identity',
  'no_change',
  'material_change',
  'snapshot_only',
  'extraction_regression',
  'ambiguous_change',
  'identity_conflict',
]);

export type CommitDecisionType = z.infer<typeof CommitDecisionTypeSchema>;

/** 结构化决策摘要（存入既有 raw_input_json 的 committedResult 载体，供审计与前端展示）。 */
export const CommitDecisionSummarySchema = z.strictObject({
  contractVersion: z.literal(CHANGE_SET_CONTRACT_VERSION),
  decisionType: CommitDecisionTypeSchema,
  changedFields: z.array(FieldChangeEntrySchema).max(CHANGE_SET_MAX_FIELDS).default([]),
  analysisEligible: z.boolean(),
  needsConfirmation: z.array(z.string().trim().min(1).max(200)).max(CHANGE_SET_MAX_FIELDS).default([]),
  blockingIssues: z.array(z.string().trim().min(1).max(300)).max(CHANGE_SET_MAX_FIELDS).default([]),
  conflictReason: z.string().trim().min(1).max(300).nullable().default(null),
});

export type CommitDecisionSummary = z.infer<typeof CommitDecisionSummarySchema>;
