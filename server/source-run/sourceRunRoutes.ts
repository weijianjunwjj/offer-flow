/**
 * OfferFlow v0.9 — SourceRun 只读观测 API（T030）。
 *
 * 边界：READ-only observability，回答「OfferFlow 今天实际跑了什么？」。
 *   - 只透出真实持久化的 SourceRun 字段（status/phase 不在此重新计算）；
 *   - plan/version provenance 按 SourceRun.searchPlanId / searchPlanVersionId 精确解析
 *     （禁止 activeVersionId / latest version 猜测）；
 *   - failure observability 透出 errorCode / errorMessage（持久化字段，非重新计算）；
 *   - DailyBrief 关联用正式 DailyBriefRepository.findByRunId 最小查询；
 *   - 不在 route 中启动 Pipeline / retry / Run Now / 创建 Brief / 触发 Scheduler（属 T032）。
 *
 * 端点（沿用现有无 /api 前缀约定，与 /daily-search-plans 一致）：
 *   GET /source-runs          列出运行记录（可过滤 planId/status/triggerType/day，有界 limit）
 *   GET /source-runs/:id      单次运行详情（含 searchPlan + dailyBrief 最小关联）
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SourceRunRepository, type SourceRunListFilter } from './sourceRunRepository';
import type { SourceRun } from './types';
import {
  SOURCE_RUN_STATUSES,
  SOURCE_RUN_TRIGGER_TYPES,
  type SourceRunStatus,
  type SourceRunTriggerType,
} from './types';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import { IdParamsSchema } from '../radar/dtoSchemas';
import type { SearchCoverage } from '../search-provider/types';

/** plan 身份最小视图（历史 PlanVersion 仍可解析为当时的 Plan name）。 */
export interface SourceRunSearchPlanView {
  id: string;
  name: string;
  versionId: string;
}

/** DailyBrief 最小关联视图（detail 用，不含内部 hash / raw JSON）。 */
export interface SourceRunDailyBriefView {
  id: string;
  briefDate: string;
  status: string;
}

/** coverage 安全投影：只透出 query 级计数与 errorCode，不透出 provider error detail / queryResults。 */
export interface SourceRunCoverageView {
  queriesCompleted: number;
  queriesFailed: number;
  failedScopes: Array<{ queryKey: string; errorCode: string }>;
}

/**
 * 阶段诊断（来自 progressJson.pipelineStages）。
 * 宽松 number 计数，回答「Pipeline 卡在哪一层」；不含任何 secret / raw JSON。
 */
export type SourceRunDiagnostics = Record<string, number>;

/** 从 progressJson 安全提取 pipelineStages 数字诊断（缺失/非对象返回 null）。 */
function extractDiagnostics(progressJson: Record<string, unknown>): SourceRunDiagnostics | null {
  const stages = progressJson['pipelineStages'];
  if (stages === null || typeof stages !== 'object' || Array.isArray(stages)) return null;
  const out: SourceRunDiagnostics = {};
  for (const [key, value] of Object.entries(stages as Record<string, unknown>)) {
    if (typeof value === 'number') out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 列表/详情共用的 SourceRun 安全视图：不含 progressJson / costSummaryJson 等内部 raw JSON。 */
export interface SourceRunView {
  id: string;
  searchPlanId: string;
  searchPlanVersionId: string;
  searchPlan: SourceRunSearchPlanView | null;
  sourceKey: string;
  sourceVersion: string;
  triggerType: SourceRunTriggerType;
  retryOfRunId: string | null;
  status: SourceRunStatus;
  phase: string;
  scheduledDay: string | null;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  queriesAttempted: number;
  queriesSucceeded: number;
  queriesFailed: number;
  resultsDiscovered: number;
  relevantResults: number;
  newCount: number;
  changedCount: number;
  duplicateCount: number;
  conflictCount: number;
  blockedCount: number;
  searchEvidencePersisted: number;
  manualReviewRequired: number;
  fullEvidenceCount: number;
  analysisEligibleCount: number;
  analysisRequestedCount: number;
  analysisSucceededCount: number;
  selectedCount: number;
  alertedCount: number;
  failedCount: number;
  estimatedSearchCredits: number | null;
  actualSearchCredits: number | null;
  coverage: SourceRunCoverageView;
  diagnostics: SourceRunDiagnostics | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

class SourceRunApiError extends Error {
  constructor(readonly statusCode: number, readonly body: { code: string; message: string }) {
    super(body.message);
    this.name = 'SourceRunApiError';
  }
}

function notFound(message: string): SourceRunApiError {
  return new SourceRunApiError(404, { code: 'NOT_FOUND', message });
}

function invalid(message: string): SourceRunApiError {
  return new SourceRunApiError(422, { code: 'VALIDATION_ERROR', message });
}

const SourceRunListQuerySchema = z.object({
  planId: z.string().trim().min(1).optional(),
  status: z.enum([...SOURCE_RUN_STATUSES] as [SourceRunStatus, ...SourceRunStatus[]]).optional(),
  triggerType: z.enum([...SOURCE_RUN_TRIGGER_TYPES] as [SourceRunTriggerType, ...SourceRunTriggerType[]]).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function toCoverageView(coverage: SearchCoverage): SourceRunCoverageView {
  return {
    queriesCompleted: coverage.queriesCompleted,
    queriesFailed: coverage.queriesFailed,
    failedScopes: coverage.failedScopes.map((f) => ({ queryKey: f.queryKey, errorCode: f.errorCode })),
  };
}

export function registerSourceRunRoutes(app: FastifyInstance): void {
  app.register(async (scoped) => {
    const sourceRunRepo = new SourceRunRepository(scoped.db);
    const searchPlanRepo = new SearchPlanRepository(scoped.db);
    const briefRepo = new DailyBriefRepository(scoped.db);

    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof SourceRunApiError) {
        return reply.code(error.statusCode).send(error.body);
      }
      const unexpected = error as Error;
      console.error('[source-runs] 未预期错误:', unexpected.name, unexpected.message);
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });

    const parseId = (input: unknown): string => {
      const result = IdParamsSchema.safeParse(input);
      if (!result.success) throw invalid(`非法 id: ${result.error.message}`);
      return result.data.id;
    };

    /**
     * 由 run.searchPlanVersionId → Version.searchPlanId → Plan.name 精确解析 plan 身份。
     * 历史旧 PlanVersion 仍可解析（不依赖当前 activeVersionId）；版本或计划缺失返回 null。
     */
    const resolveSearchPlan = (run: SourceRun): SourceRunSearchPlanView | null => {
      const version = searchPlanRepo.getVersion(run.searchPlanVersionId);
      if (version === null) return null;
      const plan = searchPlanRepo.getPlan(version.searchPlanId);
      if (plan === null) return null;
      return { id: plan.id, name: plan.name, versionId: run.searchPlanVersionId };
    };

    const toRunView = (run: SourceRun): SourceRunView => ({
      id: run.id,
      searchPlanId: run.searchPlanId,
      searchPlanVersionId: run.searchPlanVersionId,
      searchPlan: resolveSearchPlan(run),
      sourceKey: run.sourceKey,
      sourceVersion: run.sourceVersion,
      triggerType: run.triggerType,
      retryOfRunId: run.retryOfRunId,
      status: run.status,
      phase: run.phase,
      scheduledDay: run.scheduledDay,
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      queriesAttempted: run.queriesAttempted,
      queriesSucceeded: run.queriesSucceeded,
      queriesFailed: run.queriesFailed,
      resultsDiscovered: run.resultsDiscovered,
      relevantResults: run.relevantResults,
      newCount: run.newCount,
      changedCount: run.changedCount,
      duplicateCount: run.duplicateCount,
      conflictCount: run.conflictCount,
      blockedCount: run.blockedCount,
      searchEvidencePersisted: run.searchEvidencePersisted,
      manualReviewRequired: run.manualReviewRequired,
      fullEvidenceCount: run.fullEvidenceCount,
      analysisEligibleCount: run.analysisEligibleCount,
      analysisRequestedCount: run.analysisRequestedCount,
      analysisSucceededCount: run.analysisSucceededCount,
      selectedCount: run.selectedCount,
      alertedCount: run.alertedCount,
      failedCount: run.failedCount,
      estimatedSearchCredits: run.estimatedSearchCredits,
      actualSearchCredits: run.actualSearchCredits,
      coverage: toCoverageView(run.coverage),
      diagnostics: extractDiagnostics(run.progressJson),
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    });

    scoped.get('/source-runs', async (request) => {
      const parsed = SourceRunListQuerySchema.safeParse(request.query);
      if (!parsed.success) throw invalid(`非法查询参数: ${parsed.error.message}`);
      const query = parsed.data;
      const filter: SourceRunListFilter = {
        planId: query.planId,
        status: query.status,
        triggerType: query.triggerType,
        day: query.day,
        limit: query.limit,
      };
      const runs = sourceRunRepo.list(filter);
      return { runs: runs.map(toRunView), total: runs.length };
    });

    scoped.get('/source-runs/:id', async (request) => {
      const id = parseId(request.params);
      const run = sourceRunRepo.getById(id);
      if (run === null) throw notFound(`source run 不存在: ${id}`);
      const brief = briefRepo.findByRunId(id);
      const dailyBrief: SourceRunDailyBriefView | null = brief === null
        ? null
        : { id: brief.id, briefDate: brief.briefDate, status: brief.status };
      return { run: toRunView(run), dailyBrief };
    });
  });
}
