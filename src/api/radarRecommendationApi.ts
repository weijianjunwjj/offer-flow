import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

/**
 * V8-5 推荐批次前端 API。对应后端 recommendationRoutes 三接口，只承载安全出参：
 * - 不暴露 batchKey / handledStateHash / profileVersions / inputSnapshot / Prompt / JD / Token；
 * - 建议项内 evidenceKey 为稳定语义键（非数据库 ID），可安全展示；
 * - 与采集桥/评审/分析一致，所有请求带 x-offerflow-capture-client 头，过服务端安全网关。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };
function withHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

export type RecommendationKind = 'apply_now' | 'stretch' | 'verify';
export type RecommendationConfidence = 'low' | 'medium' | 'high';
export type RecommendationCondition =
  | 'verify_before_apply' | 'stretch_reach' | 'capability_gap_present'
  | 'confidence_capped_missing_baseline' | 'city_or_salary_unconfirmed';
export type RecommendationBlockReason =
  | 'no_current_analysis' | 'stale_analysis' | 'skip_recommended' | 'hard_constraint_hit'
  | 'ignored_unchanged' | 'applied_pending' | 'duplicate_candidate' | 'capacity_exceeded';
export type RecommendationEmptyReason =
  | 'no_candidates_in_scope' | 'no_current_successful_analysis' | 'all_candidates_excluded';

/** 证据引用：回指分析记录内 evidenceKey（稳定语义键），带极性。 */
export interface RecommendationEvidenceRef {
  evidenceKey: string;
  polarity: 'support' | 'counter';
}

/** 单条建议：类型 + 优先级 + 置信度 + 理由 + 证据 + 适用条件。 */
export interface RecommendationItem {
  candidateId: string;
  candidateVersionId: string;
  analysisRecordId: string;
  kind: RecommendationKind;
  priority: number;
  confidence: RecommendationConfidence;
  rationale: string;
  evidenceRefs: RecommendationEvidenceRef[];
  conditions: RecommendationCondition[];
}

/** 被排除候选：绑定候选 + 确定性阻断原因。 */
export interface BlockedCandidate {
  candidateId: string;
  candidateVersionId: string;
  analysisRecordId: string | null;
  reason: RecommendationBlockReason;
}

/** 收敛结果：0～8 条建议 + 被排除清单 + 空批原因（仅 0 条时非 null）。 */
export interface RecommendationSetV1 {
  contractVersion: number;
  recommendations: RecommendationItem[];
  blocked: BlockedCandidate[];
  emptyReason: RecommendationEmptyReason | null;
}

/** 批次安全视图：不含 batchKey / handledStateHash / profileVersions 等内部字段。 */
export interface RecommendationBatchView {
  id: string;
  status: 'succeeded' | 'failed';
  candidateVersionIds: string[];
  selectedCandidateVersionIds: string[];
  recommendationSet: RecommendationSetV1;
  diagnosisStatus: 'formed' | 'insufficient_evidence';
  emptyReason: RecommendationEmptyReason | null;
  generatedAt: number;
}

const base = '/radar';

export const radarRecommendationApi = {
  /** 生成/复用批次（幂等）：相同 scope + 相同分析/处理状态复用同一批次。 */
  createBatch(candidateVersionIds: string[], options?: SendOptions): Promise<RecommendationBatchView> {
    return apiSend(`${base}/recommendation-batches`, 'POST', { candidateVersionIds }, withHeaders(options));
  },
  getBatch(id: string, options?: ReadOptions): Promise<RecommendationBatchView> {
    return apiGet(`${base}/recommendation-batches/${encodeURIComponent(id)}`, withHeaders(options));
  },
  listRecentBatches(options?: ReadOptions): Promise<RecommendationBatchView[]> {
    return apiGet(`${base}/recommendation-batches`, withHeaders(options));
  },
};
