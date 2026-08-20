/**
 * OfferFlow v0.9 — DailyJobBrief 只读 API（T041）。
 *
 * 边界：只做 DailyJobBrief 的 read projection，绝不在 route 中触发
 *   Search / Run Pipeline / Analysis / Recommendation / build Brief。
 *   - recommendationBatch 复用既有 RecommendationBatch 正式 read contract（toRecommendationBatchView）；
 *   - discoveryItems 从 discoveryItemIds（CandidateVersion IDs）读取正式 repository 展开最小安全视图；
 *   - costSummaryJson 保持可空（null = 尚未计算，T043 再补充），不提前实现成本计算；
 *   - sourceRunIds 作为 provenance 原样透出，不在此实现通用 SourceRun API（T030）。
 *
 * 端点（沿用现有无 /api 前缀约定，与 /daily-search-plans 一致）：
 *   GET /daily-job-briefs          列出简报（按日期降序）
 *   GET /daily-job-briefs/today    今日简报（plan 时区默认 Asia/Shanghai）
 *   GET /daily-job-briefs/:id      单份简报（含 recommendationBatch + discoveryItems 展开）
 */
import type { FastifyInstance } from 'fastify';
import { DailyBriefRepository } from './dailyBriefRepository';
import type { DailyJobBrief } from './types';
import { RadarCandidateRepository } from '../radar/candidateRepository';
import { RadarCaptureRepository } from '../radar/captureRepository';
import { RadarRecommendationBatchRepository } from '../radar/recommendationBatchRepository';
import { toRecommendationBatchView } from '../radar/recommendation/recommendationDtoSchemas';
import type { RecommendationItem } from '../radar/recommendation/recommendationContract';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { IdParamsSchema } from '../radar/dtoSchemas';
import { DEFAULT_TIMEZONE, todayInTimeZone } from '../daily-run/schedule';

/** 简报所属 SearchPlan 的最小身份视图（用于前端 selector 显示 plan name，而非 UUID）。 */
export interface DailyJobBriefSearchPlanView {
  id: string;
  name: string;
  versionId: string;
}

/** 列表/详情共用的简报安全视图：不含任何内部 hash / 原始 SQL 行。 */
export interface DailyJobBriefView {
  id: string;
  briefDate: string;
  searchPlanVersionId: string;
  /** 由 searchPlanVersionId 精确解析出的 plan 身份；版本/计划缺失时为 null（历史版本仍可解析）。 */
  searchPlan: DailyJobBriefSearchPlanView | null;
  sourceRunIds: string[];
  recommendationBatchId: string;
  discoveryItemIds: string[];
  status: string;
  coverage: DailyJobBrief['coverage'];
  costSummaryJson: DailyJobBrief['costSummaryJson'];
  emptyReason: string | null;
  generatedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** discovery 条目最小安全视图：只投影候选版本身份 + 证据等级 + 基础身份与来源。 */
export interface DailyJobBriefDiscoveryItemView {
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

/** 正式推荐条目：岗位身份（按 Recommendation.candidateVersionId 精确展开）+ 推荐结论。 */
export interface DailyJobBriefRecommendationItemView {
  candidateId: string;
  candidateVersionId: string;
  evidenceLevel: string;
  title: string | null;
  company: string | null;
  city: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  provider: string | null;
  kind: RecommendationItem['kind'];
  priority: number;
  confidence: RecommendationItem['confidence'];
  rationale: string;
  conditions: RecommendationItem['conditions'];
  evidenceRefs: RecommendationItem['evidenceRefs'];
}

export interface DailyJobBriefRouteDeps {
  now?: () => number;
}

class DailyJobBriefApiError extends Error {
  constructor(readonly statusCode: number, readonly body: { code: string; message: string }) {
    super(body.message);
    this.name = 'DailyJobBriefApiError';
  }
}

function notFound(message: string): DailyJobBriefApiError {
  return new DailyJobBriefApiError(404, { code: 'NOT_FOUND', message });
}

function invalidId(message: string): DailyJobBriefApiError {
  return new DailyJobBriefApiError(422, { code: 'VALIDATION_ERROR', message });
}

function toBriefView(brief: DailyJobBrief, searchPlan: DailyJobBriefSearchPlanView | null): DailyJobBriefView {
  return {
    id: brief.id,
    briefDate: brief.briefDate,
    searchPlanVersionId: brief.searchPlanVersionId,
    searchPlan,
    sourceRunIds: brief.sourceRunIds,
    recommendationBatchId: brief.recommendationBatchId,
    discoveryItemIds: brief.discoveryItemIds,
    status: brief.status,
    coverage: brief.coverage,
    costSummaryJson: brief.costSummaryJson,
    emptyReason: brief.emptyReason,
    generatedAt: brief.generatedAt,
    completedAt: brief.completedAt,
    createdAt: brief.createdAt,
    updatedAt: brief.updatedAt,
  };
}

export function registerDailyJobBriefRoutes(
  app: FastifyInstance,
  deps: DailyJobBriefRouteDeps = {},
): void {
  const now = deps.now ?? Date.now;

  app.register(async (scoped) => {
    const briefRepo = new DailyBriefRepository(scoped.db);
    const candidateRepo = new RadarCandidateRepository(scoped.db);
    const captureRepo = new RadarCaptureRepository(scoped.db);
    const batchRepo = new RadarRecommendationBatchRepository(scoped.db);
    const searchPlanRepo = new SearchPlanRepository(scoped.db);

    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof DailyJobBriefApiError) {
        return reply.code(error.statusCode).send(error.body);
      }
      const unexpected = error as Error;
      console.error('[daily-job-briefs] 未预期错误:', unexpected.name, unexpected.message);
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });

    const parseId = (input: unknown): string => {
      const result = IdParamsSchema.safeParse(input);
      if (!result.success) throw invalidId(`非法 id: ${result.error.message}`);
      return result.data.id;
    };

    /** 展开单个 discovery item（CandidateVersion 最小安全视图）。缺失版本返回 null（调用方过滤）。 */
    const expandDiscoveryItem = (versionId: string): DailyJobBriefDiscoveryItemView | null => {
      const version = candidateRepo.getVersion(versionId);
      if (version === null) return null;
      const snapshotId = version.sourceSnapshotIds[0];
      const snapshot = snapshotId === undefined ? null : captureRepo.getSnapshot(snapshotId);
      return {
        candidateId: version.candidateId,
        candidateVersionId: version.id,
        evidenceLevel: version.evidenceLevel,
        title: version.normalized.role,
        company: version.normalized.company,
        city: version.normalized.city,
        sourceUrl: snapshot?.sourceUrl ?? null,
        sourceDomain: snapshot?.sourceDomain ?? null,
        provider: snapshot?.providerKey ?? null,
      };
    };

    /**
     * 展开单条正式推荐：岗位身份按 Recommendation.candidateVersionId 精确读取
     * （禁止 find latest / activeVersionId 猜测，展示内容与被分析证据版本一致）。
     * 缺失版本返回 null（调用方过滤），evidenceRefs 等结论字段原样透出。
     */
    const expandRecommendationItem = (rec: RecommendationItem): DailyJobBriefRecommendationItemView | null => {
      const version = candidateRepo.getVersion(rec.candidateVersionId);
      if (version === null) return null;
      const snapshotId = version.sourceSnapshotIds[0];
      const snapshot = snapshotId === undefined ? null : captureRepo.getSnapshot(snapshotId);
      return {
        candidateId: rec.candidateId,
        candidateVersionId: rec.candidateVersionId,
        evidenceLevel: version.evidenceLevel,
        title: version.normalized.role,
        company: version.normalized.company,
        city: version.normalized.city,
        sourceUrl: snapshot?.sourceUrl ?? null,
        sourceDomain: snapshot?.sourceDomain ?? null,
        provider: snapshot?.providerKey ?? null,
        kind: rec.kind,
        priority: rec.priority,
        confidence: rec.confidence,
        rationale: rec.rationale,
        conditions: rec.conditions,
        evidenceRefs: rec.evidenceRefs,
      };
    };

    /**
     * 由 brief.searchPlanVersionId → Version.searchPlanId → Plan.name 精确解析 plan 身份。
     * 历史旧 PlanVersion 仍可解析（不依赖当前 activeVersionId）；版本或计划缺失返回 null。
     */
    const resolveSearchPlan = (brief: DailyJobBrief): DailyJobBriefSearchPlanView | null => {
      const version = searchPlanRepo.getVersion(brief.searchPlanVersionId);
      if (version === null) return null;
      const plan = searchPlanRepo.getPlan(version.searchPlanId);
      if (plan === null) return null;
      return { id: plan.id, name: plan.name, versionId: brief.searchPlanVersionId };
    };

    scoped.get('/daily-job-briefs', async () => {
      const briefs = briefRepo.listRecent(50);
      return { briefs: briefs.map((brief) => toBriefView(brief, resolveSearchPlan(brief))), total: briefs.length };
    });

    // 「today」必须在「:id」之前注册，避免被参数路由捕获。
    scoped.get('/daily-job-briefs/today', async () => {
      const briefDate = todayInTimeZone(now(), DEFAULT_TIMEZONE);
      const briefs = briefRepo.findByDate(briefDate);
      return { briefDate, briefs: briefs.map((brief) => toBriefView(brief, resolveSearchPlan(brief))), total: briefs.length };
    });

    // 「date/:date」必须在「:id」之前注册，避免被参数路由捕获。
    scoped.get('/daily-job-briefs/date/:date', async (request) => {
      const params = request.params as { date: string };
      const date = params.date.trim();
      // 验证 YYYY-MM-DD 格式
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw invalidId(`非法日期格式: ${date}，期望 YYYY-MM-DD`);
      }
      const briefs = briefRepo.findByDate(date);
      return { briefDate: date, briefs: briefs.map((brief) => toBriefView(brief, resolveSearchPlan(brief))), total: briefs.length };
    });

    scoped.get('/daily-job-briefs/:id', async (request) => {
      const id = parseId(request.params);
      const brief = briefRepo.getById(id);
      if (brief === null) throw notFound(`daily job brief 不存在: ${id}`);

      const batch = batchRepo.getById(brief.recommendationBatchId);
      const batchView = batch === null ? null : toRecommendationBatchView(batch);
      const recommendationItems = batchView === null
        ? []
        : batchView.recommendationSet.recommendations
          .map(expandRecommendationItem)
          .filter((item): item is DailyJobBriefRecommendationItemView => item !== null);
      const discoveryItems = brief.discoveryItemIds
        .map(expandDiscoveryItem)
        .filter((item): item is DailyJobBriefDiscoveryItemView => item !== null);

      return {
        brief: toBriefView(brief, resolveSearchPlan(brief)),
        recommendationBatch: batchView,
        recommendationItems,
        discoveryItems,
      };
    });
  });
}
