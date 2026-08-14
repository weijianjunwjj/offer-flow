import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from './searchPlanRepository';
import { SkipRepository } from './skipRepository';
import { registerSearchPlanRoutes } from './searchPlanRoutes';
import type { DailyRunCoordinator } from '../daily-run/DailyRunCoordinator';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
  coordinatorRun: ReturnType<typeof vi.fn>;
  planRepo: SearchPlanRepository;
  skipRepo: SkipRepository;
}

function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-plan-control-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  let id = 0;
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  const coordinatorRun = vi.fn(
    async () => ({ outcome: 'completed', sourceRunId: 'run-1', status: 'SUCCEEDED', briefId: 'brief-1' }) as const,
  );
  const coordinator = { run: coordinatorRun } as unknown as DailyRunCoordinator;
  const planRepo = new SearchPlanRepository(db);
  const skipRepo = new SkipRepository(db);
  registerSearchPlanRoutes(app, {
    now: () => Date.UTC(2026, 7, 14, 2, 0), // 10:00 Asia/Shanghai → 2026-08-14
    createId: () => `id-${(id += 1)}`,
    control: { coordinator, skipRepo },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db, coordinatorRun, planRepo, skipRepo };
}

const createPayload = {
  name: '每日前端岗位',
  cities: [{ name: '苏州', priority: 1 }],
  roleDirections: ['前端开发'],
  baseKeywords: ['React'],
  sourceConfigs: [{ providerKey: 'tavily', enabled: true }],
  schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
  scanBudget: { maxQueriesPerRun: 30 },
  latestCatchUpTime: '12:00',
};

async function createPlan(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: createPayload });
  expect(res.statusCode).toBe(201);
  return (res.json() as { plan: { id: string } }).plan.id;
}

describe('DailySearchPlan 控制端点（T032）— Pause / Resume', () => {
  it('pause：active → paused；history 不删除（plan/version 仍存在）', async () => {
    const { app, db } = createHarness();
    const planId = await createPlan(app);
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plan: { status: string } }).plan.status).toBe('paused');
    // history 不删除：plan + version 仍存在。
    const plan = new SearchPlanRepository(db).getPlan(planId);
    expect(plan?.status).toBe('paused');
    expect(new SearchPlanRepository(db).listVersionsByPlan(planId)).toHaveLength(1);
  });

  it('pause 幂等：已 paused 再 pause 返回 200 且状态不变', async () => {
    const { app } = createHarness();
    const planId = await createPlan(app);
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plan: { status: string } }).plan.status).toBe('paused');
  });

  it('resume：paused → active', async () => {
    const { app } = createHarness();
    const planId = await createPlan(app);
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/resume` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plan: { status: string } }).plan.status).toBe('active');
  });

  it('resume 幂等：已 active 再 resume 返回 200 且状态不变', async () => {
    const { app } = createHarness();
    const planId = await createPlan(app);
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/resume` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plan: { status: string } }).plan.status).toBe('active');
  });
});

describe('DailySearchPlan 控制端点（T032）— Run Now', () => {
  it('active plan → 复用 coordinator（MANUAL），返回 SourceRun identity', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(res.statusCode).toBe(201);
    expect(coordinatorRun).toHaveBeenCalledTimes(1);
    const call = coordinatorRun.mock.calls[0]?.[0];
    expect(call.triggerType).toBe('MANUAL');
    expect(call.scheduledDay).toBeNull();
    expect(call.searchPlanVersionId).toBeTruthy();
    expect(res.json()).toMatchObject({ sourceRunId: 'run-1', status: 'SUCCEEDED', briefId: 'brief-1' });
  });

  it('paused plan 仍允许 manual Run Now（pause 只关自动调度，不禁止人工执行）', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(res.statusCode).toBe(201);
    expect(coordinatorRun).toHaveBeenCalledTimes(1);
  });

  it('deleted plan → 409 PLAN_DELETED（禁止 Run Now）', async () => {
    const { app, db } = createHarness();
    const planId = await createPlan(app);
    new SearchPlanRepository(db).updatePlan(planId, { status: 'deleted', deletedAt: Date.UTC(2026, 7, 14, 3, 0) });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PLAN_DELETED' });
  });

  it('Run Now 使用当前 active PlanVersion（新版本激活后指向最新）', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    const v2Res = await app.inject({
      method: 'POST',
      url: `/daily-search-plans/${planId}/versions`,
      payload: { ...createPayload, cities: [{ name: '上海', priority: 1 }] },
    });
    const activeVersionId = (v2Res.json() as { version: { id: string } }).version.id;

    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(coordinatorRun.mock.calls[0]?.[0].searchPlanVersionId).toBe(activeVersionId);
  });

  it('Run Now 不重实现 Pipeline：仅 resolve active version + invoke coordinator', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    // coordinator 只被调一次，且 route 未自己创建 SourceRun（无额外副作用断言可用，以调用契约为准）。
    expect(coordinatorRun).toHaveBeenCalledTimes(1);
    expect(coordinatorRun.mock.calls[0]?.[0]).toMatchObject({
      triggerType: 'MANUAL',
      scheduledDay: null,
    });
  });

  it('plan 无 active version → 409 NO_ACTIVE_VERSION', async () => {
    const { app, db } = createHarness();
    new SearchPlanRepository(db).insertPlan({
      id: 'plan-no-version', name: 'p', status: 'active', activeVersionId: null,
      createdAt: 1000, updatedAt: 1000, deletedAt: null,
    });
    const res = await app.inject({ method: 'POST', url: '/daily-search-plans/plan-no-version/run-now' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'NO_ACTIVE_VERSION' });
  });

  it('coordinator 返回 skipped（FR-007 并发）→ 409 RUN_IN_PROGRESS', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    coordinatorRun.mockResolvedValueOnce({ outcome: 'skipped' } as const);
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });
});

describe('DailySearchPlan 控制端点（T032）— Skip Today', () => {
  it('skip-today 持久化当前 plan timezone 自然日；restart 后仍存在', async () => {
    const { app, skipRepo } = createHarness();
    const planId = await createPlan(app);
    const versionId = new SearchPlanRepository((app as unknown as { db: SqliteDatabase }).db).getActiveVersion(planId)!.id;

    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ skipped: { searchPlanVersionId: versionId, scheduledDay: '2026-08-14' } });
    // 持久化：直接读 SkipRepository 仍命中（模拟进程重启后仍存在）。
    expect(skipRepo.isSkipped(versionId, '2026-08-14')).toBe(true);
  });

  it('skip-today 幂等：重复 skip 同一天仍 200 且只有一行', async () => {
    const { app, skipRepo } = createHarness();
    const planId = await createPlan(app);
    const versionId = new SearchPlanRepository((app as unknown as { db: SqliteDatabase }).db).getActiveVersion(planId)!.id;
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
    expect(skipRepo.listByVersion(versionId)).toHaveLength(1);
  });

  it('Run Now 绕过 Skip Today（MANUAL 明确操作仍允许执行）', async () => {
    const { app, coordinatorRun } = createHarness();
    const planId = await createPlan(app);
    await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/run-now` });
    expect(res.statusCode).toBe(201);
    expect(coordinatorRun).toHaveBeenCalledTimes(1);
  });

  it('deleted plan → 409 PLAN_DELETED（禁止 skip-today）', async () => {
    const { app, db } = createHarness();
    const planId = await createPlan(app);
    new SearchPlanRepository(db).updatePlan(planId, { status: 'deleted', deletedAt: Date.UTC(2026, 7, 14, 3, 0) });
    const res = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PLAN_DELETED' });
  });
});

describe('DailySearchPlan 控制端点（T032）— 校验 / 404', () => {
  it('非法 id → 422', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'POST', url: '/daily-search-plans/ /pause' });
    expect(res.statusCode).toBe(422);
  });

  it('plan 不存在 → 404', async () => {
    const { app } = createHarness();
    for (const action of ['pause', 'resume', 'skip-today', 'run-now']) {
      const res = await app.inject({ method: 'POST', url: `/daily-search-plans/missing/${action}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('DailySearchPlan 控制端点生产注册（真实 buildServer 非 404）', () => {
  it('buildServer 开启 dailySearchPlan 后控制端点真实注册可达', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-plan-control-prod-'));
    const dbPath = path.join(tempDir, 'test.sqlite3');
    const db = openDb(dbPath);
    runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
    const app = buildServer({ db, dailySearchPlan: { enabled: true } });
    try {
      // 创建计划后 pause / resume / skip-today 不触达外部网络（run-now 会，这里只验证注册）。
      const created = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: { name: '生产注册测试' } });
      const planId = (created.json() as { plan: { id: string } }).plan.id;

      const pause = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/pause` });
      expect(pause.statusCode).toBe(200);
      expect((pause.json() as { plan: { status: string } }).plan.status).toBe('paused');

      const resume = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/resume` });
      expect(resume.statusCode).toBe(200);

      const skip = await app.inject({ method: 'POST', url: `/daily-search-plans/${planId}/skip-today` });
      expect(skip.statusCode).toBe(200);

      // run-now 用「missing plan」验证路由已注册（避免真实触达 Tavily/LLM）。
      const runMissing = await app.inject({ method: 'POST', url: '/daily-search-plans/missing/run-now' });
      expect(runMissing.statusCode).toBe(404);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
