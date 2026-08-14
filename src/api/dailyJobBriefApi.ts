/**
 * OfferFlow v0.9 — DailyJobBrief API 客户端（T042）。
 *
 * 只封装后端 T041 已实现的只读端点，以 server/daily-brief/dailyBriefRoutes.ts 的真实
 * DTO 为唯一契约（无 /api 前缀，与 /daily-search-plans 一致）。前端不做任何 Pipeline
 * 编排 / 推荐生成 / Brief 构建——全部以后端为真源；today 的 product-day 完全以后端
 * /daily-job-briefs/today 返回的 briefDate 为准，不用浏览器 local date 重算。
 */
import { apiGet, type ReadOptions } from './client';
import type {
  RecommendationBatchView,
  RecommendationCondition,
  RecommendationConfidence,
  RecommendationEvidenceRef,
  RecommendationKind,
} from './radarRecommendationApi';

const base = '/daily-job-briefs';

export type DailyJobBriefStatus = 'GENERATING' | 'READY' | 'IN_REVIEW' | 'COMPLETED' | 'FAILED';

/** 查询级覆盖结果（SearchCoverage.queryResults 元素）。 */
export interface QueryCoverageResult {
  queryKey: string;
  status: 'COMPLETED' | 'FAILED' | 'VALID_EMPTY';
  resultsReturned: number;
  errorCode?: string;
  errorMessage?: string;
}

/** 失败 scope（只透出 errorCode，不透 Provider 细节）。 */
export interface FailedScope {
  queryKey: string;
  errorCode: string;
  message: string;
}

/** 搜索覆盖（复用 SearchCoverage，Provider-neutral）。 */
export interface SearchCoverage {
  queriesCompleted: number;
  queriesFailed: number;
  failedScopes: FailedScope[];
  queryResults: QueryCoverageResult[];
}

/** CostSummary 最小占位（T043 再计算）。 */
export interface CostSummary {
  estimatedSearchCredits?: number;
  actualSearchCredits?: number;
  analysisCount?: number;
  modelUsage?: string;
  tokenCount?: number;
  actualCost?: number;
}

/** 简报所属 SearchPlan 的最小身份（用于 selector 显示 plan name，而非 UUID）。 */
export interface DailyJobBriefSearchPlan {
  id: string;
  name: string;
  versionId: string;
}

/** 简报安全视图（不含内部 hash / 原始行）。 */
export interface DailyJobBrief {
  id: string;
  briefDate: string;
  searchPlanVersionId: string;
  searchPlan: DailyJobBriefSearchPlan | null;
  sourceRunIds: string[];
  recommendationBatchId: string;
  discoveryItemIds: string[];
  status: string;
  coverage: SearchCoverage;
  costSummaryJson: CostSummary | null;
  emptyReason: string | null;
  generatedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** discovery 条目最小安全视图（SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED）。 */
export interface DailyJobBriefDiscoveryItem {
  candidateId: string;
  candidateVersionId: string;
  evidenceLevel: string;
  title: string | null;
  company: string | null;
  city: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  provider: string | null;
}

/** 正式推荐条目：岗位身份（按 candidateVersionId 精确展开）+ 推荐结论。 */
export interface DailyJobBriefRecommendationItem {
  candidateId: string;
  candidateVersionId: string;
  evidenceLevel: string;
  title: string | null;
  company: string | null;
  city: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  provider: string | null;
  kind: RecommendationKind;
  priority: number;
  confidence: RecommendationConfidence;
  rationale: string;
  conditions: RecommendationCondition[];
  evidenceRefs: RecommendationEvidenceRef[];
}

export interface DailyJobBriefListResponse {
  briefs: DailyJobBrief[];
  total: number;
}

export interface DailyJobBriefTodayResponse {
  briefDate: string;
  briefs: DailyJobBrief[];
  total: number;
}

export interface DailyJobBriefDetailResponse {
  brief: DailyJobBrief;
  recommendationBatch: RecommendationBatchView | null;
  recommendationItems: DailyJobBriefRecommendationItem[];
  discoveryItems: DailyJobBriefDiscoveryItem[];
}

export const dailyJobBriefApi = {
  list(options?: ReadOptions): Promise<DailyJobBriefListResponse> {
    return apiGet(base, options);
  },
  today(options?: ReadOptions): Promise<DailyJobBriefTodayResponse> {
    return apiGet(`${base}/today`, options);
  },
  get(id: string, options?: ReadOptions): Promise<DailyJobBriefDetailResponse> {
    return apiGet(`${base}/${encodeURIComponent(id)}`, options);
  },
};
