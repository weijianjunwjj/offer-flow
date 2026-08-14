import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SearchPlanRepository } from './searchPlanRepository';
import type { DailySearchPlan, DailySearchPlanVersion } from './types';
import {
  CreateSearchPlanRequestSchema,
  CreateSearchPlanVersionRequestSchema,
  IdParamsSchema,
  type SearchPlanConfigInput,
} from './searchPlanDtoSchemas';
import { normalizeScheduleInput } from '../daily-run/schedule';

/**
 * OfferFlow v0.9 — DailySearchPlan API 路由（T022）。
 *
 * 只暴露 DailySearchPlan / DailySearchPlanVersion 的真实 repository contract，
 * 是 read/write boundary，不是 pipeline orchestration：
 *   - 不实现 Scheduler / Run Now / Skip Today / Pause / Resume（T032 控制端点）；
 *   - 不触发 SourceRun 或搜索（那是 Scheduler / Pipeline 的职责）。
 *
 * 端点：
 *   POST /daily-search-plans                     创建计划 + 首个活跃版本
 *   GET  /daily-search-plans                     列出计划
 *   GET  /daily-search-plans/:id                 获取计划（含 active version）
 *   GET  /daily-search-plans/:id/versions        列出版本
 *   POST /daily-search-plans/:id/versions        创建新版本并激活（版本号递增）
 */

class SearchPlanApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  toBody(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

function invalidInput(message: string): SearchPlanApiError {
  return new SearchPlanApiError(422, 'VALIDATION_ERROR', message);
}

function notFound(message: string): SearchPlanApiError {
  return new SearchPlanApiError(404, 'NOT_FOUND', message);
}

export interface SearchPlanRouteDeps {
  now?: () => number;
  createId?: () => string;
}

function buildVersion(
  config: SearchPlanConfigInput,
  fields: {
    planId: string;
    versionNo: number;
    versionId: string;
    createdAt: number;
    activatedAt: number | null;
  },
): DailySearchPlanVersion {
  return {
    id: fields.versionId,
    searchPlanId: fields.planId,
    version: fields.versionNo,
    cities: config.cities,
    roleDirections: config.roleDirections,
    baseKeywords: config.baseKeywords,
    expandedKeywords: config.expandedKeywords,
    hardConstraints: config.hardConstraints,
    sourceConfigs: config.sourceConfigs,
    schedule: normalizeScheduleInput(config.schedule),
    scanBudget: config.scanBudget,
    analysisBudget: config.analysisBudget,
    briefPolicy: config.briefPolicy,
    explorationPolicy: config.explorationPolicy,
    notificationPolicy: config.notificationPolicy,
    latestCatchUpTime: config.latestCatchUpTime,
    createdAt: fields.createdAt,
    activatedAt: fields.activatedAt,
    supersedesVersionId: null,
  };
}

export function registerSearchPlanRoutes(
  app: FastifyInstance,
  deps: SearchPlanRouteDeps = {},
): void {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? randomUUID;

  app.register(async (scoped) => {
    const repo = new SearchPlanRepository(scoped.db);

    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof SearchPlanApiError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });

    const idFrom = (input: unknown): string => {
      const result = IdParamsSchema.safeParse(input);
      if (!result.success) throw invalidInput(`非法 id: ${result.error.message}`);
      return result.data.id;
    };

    scoped.post('/daily-search-plans', async (request, reply) => {
      const parsed = CreateSearchPlanRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidInput(parsed.error.message);
      const { name, ...config } = parsed.data;

      const planId = createId();
      const versionId = createId();
      const ts = now();
      // active_version_id 有 FK 指向 daily_search_plan_versions，且 version 的
      // search_plan_id 有 FK 指向 daily_search_plans（循环 FK）：先建 plan（activeVersionId=null），
      // 再建 version，最后 setActiveVersion 回填 plan.active_version_id。
      const plan: DailySearchPlan = {
        id: planId,
        name,
        status: 'active',
        activeVersionId: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
      };
      const version = buildVersion(config, {
        planId,
        versionNo: 1,
        versionId,
        createdAt: ts,
        activatedAt: null,
      });
      repo.insertPlan(plan);
      repo.insertVersion(version);
      repo.setActiveVersion(planId, versionId);
      return reply.code(201).send({ plan: repo.getPlan(planId)!, version: repo.getVersion(versionId)! });
    });

    scoped.get('/daily-search-plans', async () => ({ plans: repo.listPlans() }));

    scoped.get('/daily-search-plans/:id', async (request) => {
      const id = idFrom(request.params);
      const plan = repo.getPlan(id);
      if (plan === null) throw notFound(`search plan 不存在: ${id}`);
      return { plan, activeVersion: repo.getActiveVersion(id) };
    });

    scoped.get('/daily-search-plans/:id/versions', async (request) => {
      const id = idFrom(request.params);
      const plan = repo.getPlan(id);
      if (plan === null) throw notFound(`search plan 不存在: ${id}`);
      return { versions: repo.listVersionsByPlan(id) };
    });

    scoped.post('/daily-search-plans/:id/versions', async (request, reply) => {
      const id = idFrom(request.params);
      const plan = repo.getPlan(id);
      if (plan === null) throw notFound(`search plan 不存在: ${id}`);
      const parsed = CreateSearchPlanVersionRequestSchema.safeParse(request.body);
      if (!parsed.success) throw invalidInput(parsed.error.message);

      const nextVersionNo = (repo.listVersionsByPlan(id)[0]?.version ?? 0) + 1;
      const versionId = createId();
      const ts = now();
      const version = buildVersion(parsed.data, {
        planId: id,
        versionNo: nextVersionNo,
        versionId,
        createdAt: ts,
        activatedAt: null,
      });
      repo.insertVersion(version);
      repo.setActiveVersion(id, versionId);
      return reply.code(201).send({ version: repo.getVersion(versionId)! });
    });
  });
}
