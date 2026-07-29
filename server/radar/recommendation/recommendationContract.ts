/**
 * V8-5 第一波 · 0～8 条岗位建议领域契约 `RecommendationSetV1`。
 *
 * 这是推荐批次收敛结果的**严格领域契约**（供后续波次落库 selected/diagnosis 与前端消费）。
 * 本波次只定义契约 + 确定性生成 + 校验，不接 HTTP、不接前端、不落 migration。
 *
 * 硬边界（对齐 AGENTS.md §5.8 / Release Contract RC-08）：
 * - 每批最多 8 条建议，允许 0 条；
 * - 禁止为凑数降低标准（无兜底填充：不够就是不够）；
 * - 只用 current 成功分析，stale 一律不进正式推荐；
 * - 已忽略未变化、已投递待反馈的候选被抑制，不作为新机会重复推荐；
 * - 每条建议携带：类型、优先级、证据引用、适用条件；被排除候选携带明确阻断原因。
 */
import { z } from 'zod';

export const RECOMMENDATION_CONTRACT_VERSION = 1;
export const MAX_RECOMMENDATIONS = 8;
const EVIDENCE_REFS_MAX = 12;
const TEXT_MAX = 500;

/** 建议类型：只表达"值得处理"的三档；skip 不是建议（表现为被排除，reason=skip_recommended）。 */
export const RECOMMENDATION_KINDS = ['apply_now', 'stretch', 'verify'] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/** 适用条件：确定性地由分析事实派生，说明"在什么前提下这条建议成立"。 */
export const RECOMMENDATION_CONDITIONS = [
  'verify_before_apply',
  'stretch_reach',
  'capability_gap_present',
  'confidence_capped_missing_baseline',
  'city_or_salary_unconfirmed',
] as const;
export type RecommendationCondition = (typeof RECOMMENDATION_CONDITIONS)[number];

/** 阻断原因：候选未进入建议的确定性理由（按 §5.8 抑制/门禁 + 收敛上限）。 */
export const RECOMMENDATION_BLOCK_REASONS = [
  'no_current_analysis',
  'stale_analysis',
  'skip_recommended',
  'hard_constraint_hit',
  'ignored_unchanged',
  'applied_pending',
  'duplicate_candidate',
  'capacity_exceeded',
] as const;
export type RecommendationBlockReason = (typeof RECOMMENDATION_BLOCK_REASONS)[number];

export const RECOMMENDATION_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type RecommendationConfidence = (typeof RECOMMENDATION_CONFIDENCES)[number];

/** 证据引用：回指分析记录内的 evidenceKey（稳定语义键，非数据库 ID），带极性。 */
export interface RecommendationEvidenceRef {
  evidenceKey: string;
  polarity: 'support' | 'counter';
}

/** 单条建议：类型 + 优先级 + 证据引用 + 适用条件，绑定明确的 candidateVersionId 与来源分析记录。 */
export interface RecommendationItem {
  candidateId: string;
  candidateVersionId: string;
  analysisRecordId: string;
  kind: RecommendationKind;
  /** 批内优先级，1 为最高；连续无空洞，稳定确定性排序结果。 */
  priority: number;
  confidence: RecommendationConfidence;
  rationale: string;
  evidenceRefs: RecommendationEvidenceRef[];
  conditions: RecommendationCondition[];
}

/** 被排除候选：绑定候选与（若有）来源分析记录 + 确定性阻断原因。 */
export interface BlockedCandidate {
  candidateId: string;
  candidateVersionId: string;
  analysisRecordId: string | null;
  reason: RecommendationBlockReason;
}

/** 收敛结果：0～8 条建议 + 被排除清单 + 空批原因（仅在 0 条时非 null）。 */
export interface RecommendationSetV1 {
  contractVersion: typeof RECOMMENDATION_CONTRACT_VERSION;
  recommendations: RecommendationItem[];
  blocked: BlockedCandidate[];
  emptyReason: RecommendationEmptyReason | null;
}

/** 空批原因：区分"无候选入场""无 current 成功分析""全部被排除"。 */
export const RECOMMENDATION_EMPTY_REASONS = [
  'no_candidates_in_scope',
  'no_current_successful_analysis',
  'all_candidates_excluded',
] as const;
export type RecommendationEmptyReason = (typeof RECOMMENDATION_EMPTY_REASONS)[number];

const id = z.string().trim().min(1).max(120);
const text = z.string().min(1).max(TEXT_MAX);
const evidenceKey = z.string().trim().min(1).max(TEXT_MAX);

export const RecommendationEvidenceRefSchema: z.ZodType<RecommendationEvidenceRef> = z.strictObject({
  evidenceKey,
  polarity: z.enum(['support', 'counter']),
});

export const RecommendationItemSchema: z.ZodType<RecommendationItem> = z.strictObject({
  candidateId: id,
  candidateVersionId: id,
  analysisRecordId: id,
  kind: z.enum(RECOMMENDATION_KINDS),
  priority: z.number().int().min(1).max(MAX_RECOMMENDATIONS),
  confidence: z.enum(RECOMMENDATION_CONFIDENCES),
  rationale: text,
  evidenceRefs: z.array(RecommendationEvidenceRefSchema).max(EVIDENCE_REFS_MAX),
  conditions: z.array(z.enum(RECOMMENDATION_CONDITIONS)).max(RECOMMENDATION_CONDITIONS.length),
});

export const BlockedCandidateSchema: z.ZodType<BlockedCandidate> = z.strictObject({
  candidateId: id,
  candidateVersionId: id,
  analysisRecordId: id.nullable(),
  reason: z.enum(RECOMMENDATION_BLOCK_REASONS),
});

/**
 * 严格集合校验（结构 + 数量上限 + 优先级连续 + 空批一致性）。
 * 关键不变量：≤8 条；priority 恰为 1..n 无重复无空洞；0 条时 emptyReason 必须非 null，
 * 反之 >0 条时 emptyReason 必须为 null（不得既有建议又标空批）。
 */
export const RecommendationSetV1Schema = z
  .strictObject({
    contractVersion: z.literal(RECOMMENDATION_CONTRACT_VERSION),
    recommendations: z.array(RecommendationItemSchema).max(MAX_RECOMMENDATIONS),
    blocked: z.array(BlockedCandidateSchema),
    emptyReason: z.enum(RECOMMENDATION_EMPTY_REASONS).nullable(),
  })
  .superRefine((set, ctx) => {
    const priorities = set.recommendations.map((r) => r.priority).sort((a, b) => a - b);
    priorities.forEach((p, index) => {
      if (p !== index + 1) {
        ctx.addIssue({ code: 'custom', message: `priority 必须为连续 1..n（发现 ${p}，期望 ${index + 1}）` });
      }
    });
    if (set.recommendations.length === 0 && set.emptyReason === null) {
      ctx.addIssue({ code: 'custom', message: '0 条建议时 emptyReason 必须非 null' });
    }
    if (set.recommendations.length > 0 && set.emptyReason !== null) {
      ctx.addIssue({ code: 'custom', message: '存在建议时 emptyReason 必须为 null' });
    }
  });

/** 校验并返回 RecommendationSetV1，失败抛出（携带首个校验路径）。 */
export function parseRecommendationSet(value: unknown): RecommendationSetV1 {
  return RecommendationSetV1Schema.parse(value) as RecommendationSetV1;
}
