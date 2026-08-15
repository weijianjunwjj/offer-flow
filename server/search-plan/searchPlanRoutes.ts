import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SearchPlanRepository } from './searchPlanRepository';
import { SkipRepository } from './skipRepository';
import type { DailySearchPlan, DailySearchPlanVersion } from './types';
import {
  CreateSearchPlanRequestSchema,
  CreateSearchPlanVersionRequestSchema,
  IdParamsSchema,
  type SearchPlanConfigInput,
} from './searchPlanDtoSchemas';
import { normalizeScheduleInput, parseDailySearchSchedule, todayInTimeZone } from '../daily-run/schedule';
import type { DailyRunCoordinator } from '../daily-run/DailyRunCoordinator';

/**
 * OfferFlow v0.9 — DailySearchPlan API 路由（T022 CRUD + T032 控制端点）。
 *
 * 只暴露 DailySearchPlan / DailySearchPlanVersion 的真实 repository contract，是 read/write boundary。
 * CRUD（T022）：创建/列出/查询/版本。
 * 控制端点（T032，`control` deps 提供时注册）：
 *   pause / resume（DailySearchPlan.status 状态切换）、
 *   skip-today（SkipRepository 持久化）、
 *   run-now（复用 DailyRunCoordinator.run，triggerType=MANUAL，不自己 Search/Pipeline/create SourceRun）。
 *
 * 冻结边界（v0.9 Wake Admin-Bootstrap）：
 *   WAKE_TASK_MUTATION_FROM_SERVER = FORBIDDEN
 *   create / version / pause / resume 绝不 mutation Windows Task Scheduler。
 *   Windows wake task 是管理员引导产物；schedule 变化由用户在提权 CLI 重新 reconcile。
 *
 * 端点：
 *   POST /daily-search-plans                     创建计划 + 首个活跃版本
 *   GET  /daily-search-plans                     列出计划
 *   GET  /daily-search-plans/:id                 获取计划（含 active version）
 *   GET  /daily-search-plans/:id/versions        列出版本
 *   POST /daily-search-plans/:id/versions        创建新版本并激活（版本号递增）
 *   POST /daily-search-plans/:id/pause           暂停自动调度（T032）
 *   POST /daily-search-plans/:id/resume          恢复自动调度（T032）
 *   POST /daily-search-plans/:id/skip-today      跳过今日自动调度（T032）
 *   POST /daily-search-plans/:id/run-now         立即手动运行（T032）
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

function conflict(code: string, message: string): SearchPlanApiError {
  return new SearchPlanApiError(409, code, message);
}

/** T032 Plan Control 控制端点依赖（未提供时不注册控制端点，仅 CRUD）。 */
export interface SearchPlanControlDeps {
  coordinator: DailyRunCoordinator;
  skipRepo: SkipRepository;
}

export interface SearchPlanRouteDeps {
  now?: () => number;
  createId?: () => string;
  /** T032 控制端点（run-now / skip-today / pause / resume）；缺省仅注册 CRUD。 */
  control?: SearchPlanControlDeps;
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
  const control = deps.control;

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

    // ── T032 Plan Control（仅当 control deps 提供时注册）────────────────────────
    if (control !== undefined) {
      const resolveControllablePlan = (id: string): DailySearchPlan => {
        const plan = repo.getPlan(id);
        if (plan === null) throw notFound(`search plan 不存在: ${id}`);
        if (plan.status === 'deleted') throw conflict('PLAN_DELETED', '计划已删除，禁止控制操作');
        return plan;
      };
      const resolveActiveVersion = (id: string): DailySearchPlanVersion => {
        const version = repo.getActiveVersion(id);
        if (version === null) throw conflict('NO_ACTIVE_VERSION', '计划没有激活版本');
        return version;
      };

      scoped.post('/daily-search-plans/:id/pause', async (request) => {
        const id = idFrom(request.params);
        const plan = resolveControllablePlan(id);
        if (plan.status !== 'paused') repo.updatePlan(id, { status: 'paused' });
        return { plan: repo.getPlan(id)! };
      });

      scoped.post('/daily-search-plans/:id/resume', async (request) => {
        const id = idFrom(request.params);
        const plan = resolveControllablePlan(id);
        if (plan.status !== 'active') repo.updatePlan(id, { status: 'active' });
        return { plan: repo.getPlan(id)! };
      });

      scoped.post('/daily-search-plans/:id/skip-today', async (request) => {
        const id = idFrom(request.params);
        resolveControllablePlan(id);
        const version = resolveActiveVersion(id);
        const schedule = parseDailySearchSchedule(version.schedule);
        const scheduledDay = todayInTimeZone(now(), schedule.timezone);
        control.skipRepo.skip(version.id, scheduledDay, 'user_skipped_today', now());
        return { skipped: { searchPlanVersionId: version.id, scheduledDay } };
      });

      scoped.post('/daily-search-plans/:id/run-now', async (request, reply) => {
        const id = idFrom(request.params);
        resolveControllablePlan(id);
        const version = resolveActiveVersion(id);
        // 复用 DailyRunCoordinator.run（MANUAL），不自己 Search/Pipeline/create SourceRun。
        const result = await control.coordinator.run({
          searchPlanVersionId: version.id,
          triggerType: 'MANUAL',
          scheduledFor: now(),
          scheduledDay: null,
        });
        if (result.outcome === 'skipped') {
          // FR-007：同 plan 已有 active run，第二个请求返回稳定 conflict 而非启动第二条 Pipeline。
          return reply.code(409).send({ code: 'RUN_IN_PROGRESS', message: '该计划已有进行中的运行' });
        }
        return reply.code(201).send({
          sourceRunId: result.sourceRunId,
          status: result.status,
          briefId: result.briefId,
        });
      });
    }
  });
}
