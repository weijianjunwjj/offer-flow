/**
 * V8-5 推荐批次 HTTP 边界 · 严格 DTO 与安全出参视图。
 *
 * - 入参：candidateVersionIds 白名单（非空、去重上限、非空串），拒绝多余字段；
 * - 出参：批次安全视图——只投影 id/状态/选中版本/富建议结果/元信息，
 *   绝不外泄 handledStateHash / profileVersions 内部映射 / batchKey 等内部字段。
 *   建议项内的 evidenceKey 是稳定语义键（非数据库 ID），可安全透出。
 */
import { z } from 'zod';
import type { RadarRecommendationBatch } from '../../../src/domain/radar';
import { MAX_SCOPE_ITEMS } from './recommendationBatchService';
import { RecommendationSetV1Schema, type RecommendationSetV1 } from './recommendationContract';

const nonBlankId = z.string().trim().min(1).max(120);

/** 创建批次入参：非空候选版本集合（strict 拒绝未知字段）。 */
export const CreateBatchRequestSchema = z.strictObject({
  candidateVersionIds: z.array(nonBlankId).min(1).max(MAX_SCOPE_ITEMS),
});
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

/** 批次安全视图：不含 batchKey/handledStateHash/profileVersions 等内部字段。 */
export interface RecommendationBatchView {
  id: string;
  status: string;
  candidateVersionIds: string[];
  selectedCandidateVersionIds: string[];
  recommendationSet: RecommendationSetV1;
  diagnosisStatus: string;
  emptyReason: string | null;
  generatedAt: number;
}

/**
 * 从存储批次投影安全视图。scope 内冻结的 recommendationSet 经严格 schema 复校后透出，
 * 存储损坏（非法结构）即抛（由路由层映射 500，不透传原文）。
 */
export function toRecommendationBatchView(batch: RadarRecommendationBatch): RecommendationBatchView {
  const scope = batch.scope as { recommendationSet?: unknown } | null;
  const recommendationSet = RecommendationSetV1Schema.parse(scope?.recommendationSet) as RecommendationSetV1;
  return {
    id: batch.id,
    status: batch.status,
    candidateVersionIds: batch.candidateVersionIds,
    selectedCandidateVersionIds: batch.selectedCandidateVersionIds,
    recommendationSet,
    diagnosisStatus: batch.diagnosisStatus,
    emptyReason: batch.emptyReason,
    generatedAt: batch.generatedAt,
  };
}
