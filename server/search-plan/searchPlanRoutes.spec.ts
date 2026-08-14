import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { DAILY_SEARCH_PLAN_SCHEMA_VERSION, runMigrations } from '../migrations';
import { registerSearchPlanRoutes } from './searchPlanRoutes';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-search-plan-api-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_SCHEMA_VERSION });
  let id = 0;
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  registerSearchPlanRoutes(app, {
    now: () => 1000,
    createId: () => `id-${(id += 1)}`,
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

const createPayload = {
  name: '每日前端岗位',
  cities: [
    { name: '苏州', priority: 1 },
    { name: '无锡', priority: 2 },
  ],
  roleDirections: ['前端开发'],
  baseKeywords: ['React', 'TypeScript'],
  sourceConfigs: [{ providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true }],
  schedule: { dailyAt: '09:00' },
  scanBudget: { maxQueriesPerRun: 30 },
  latestCatchUpTime: '12:00',
};

describe('DailySearchPlan API（T022）', () => {
  it('POST /daily-search-plans 创建计划 + 首个活跃版本', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: createPayload });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      plan: { id: string; name: string; status: string; activeVersionId: string };
      version: { id: string; version: number; searchPlanId: string; cities: unknown[] };
    };
    expect(body.plan.name).toBe('每日前端岗位');
    expect(body.plan.status).toBe('active');
    expect(body.version.version).toBe(1);
    expect(body.version.searchPlanId).toBe(body.plan.id);
    expect(body.plan.activeVersionId).toBe(body.version.id);
    expect(body.version.cities).toEqual(createPayload.cities);
  });

  it('GET /daily-search-plans 列出计划', async () => {
    const { app } = createHarness();
    await app.inject({ method: 'POST', url: '/daily-search-plans', payload: createPayload });
    const res = await app.inject({ method: 'GET', url: '/daily-search-plans' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plans: Array<{ name: string }> };
    expect(body.plans).toHaveLength(1);
    expect(body.plans[0]?.name).toBe('每日前端岗位');
  });

  it('GET /daily-search-plans/:id 返回计划 + activeVersion', async () => {
    const { app } = createHarness();
    const created = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: createPayload });
    const planId = (created.json() as { plan: { id: string } }).plan.id;
    const res = await app.inject({ method: 'GET', url: `/daily-search-plans/${planId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { plan: { id: string }; activeVersion: { version: number } | null };
    expect(body.plan.id).toBe(planId);
    expect(body.activeVersion?.version).toBe(1);
  });

  it('GET /daily-search-plans/:id 不存在返回 404', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'GET', url: '/daily-search-plans/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('POST /daily-search-plans/:id/versions 创建新版本并激活（版本号递增）', async () => {
    const { app } = createHarness();
    const created = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: createPayload });
    const planId = (created.json() as { plan: { id: string } }).plan.id;

    const v2Res = await app.inject({
      method: 'POST',
      url: `/daily-search-plans/${planId}/versions`,
      payload: { ...createPayload, cities: [{ name: '上海', priority: 1 }] },
    });
    expect(v2Res.statusCode).toBe(201);
    const v2 = (v2Res.json() as { version: { id: string; version: number; cities: unknown[] } }).version;
    expect(v2.version).toBe(2);
    expect(v2.cities).toEqual([{ name: '上海', priority: 1 }]);

    // 新版本成为活跃版本
    const planRes = await app.inject({ method: 'GET', url: `/daily-search-plans/${planId}` });
    const planBody = planRes.json() as { plan: { activeVersionId: string }; activeVersion: { version: number } };
    expect(planBody.plan.activeVersionId).toBe(v2.id);
    expect(planBody.activeVersion.version).toBe(2);

    // 版本列表按 version 降序为 [2, 1]
    const versionsRes = await app.inject({ method: 'GET', url: `/daily-search-plans/${planId}/versions` });
    const versions = (versionsRes.json() as { versions: Array<{ version: number }> }).versions.map((v) => v.version);
    expect(versions).toEqual([2, 1]);
  });

  it('POST /daily-search-plans 非法 body（空 name）返回 422', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: { name: '   ' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('缺省 config 字段补齐默认值（空数组 / 默认 latestCatchUpTime）', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'POST', url: '/daily-search-plans', payload: { name: '最小计划' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      version: { cities: unknown[]; sourceConfigs: unknown[]; latestCatchUpTime: string };
    };
    expect(body.version.cities).toEqual([]);
    expect(body.version.sourceConfigs).toEqual([]);
    expect(body.version.latestCatchUpTime).toBe('12:00');
  });
});

describe('DailySearchPlan API 生产注册（真实 app 非 404）', () => {
  it('buildServer 开启 dailySearchPlan 后 POST /daily-search-plans 可达 contract', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-search-plan-prod-'));
    const dbPath = path.join(tempDir, 'test.sqlite3');
    const db = openDb(dbPath);
    runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_SCHEMA_VERSION });
    const app = buildServer({ db, dailySearchPlan: { enabled: true } });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/daily-search-plans',
        payload: { name: '生产注册测试' },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { plan: { name: string }; version: { version: number } };
      expect(body.plan.name).toBe('生产注册测试');
      expect(body.version.version).toBe(1);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('DailySearchPlan schedule timezone normalization（T028 contract）', () => {
  it('timezone omitted → 持久化 Asia/Shanghai', async () => {
    const { app } = createHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/daily-search-plans',
      payload: { name: '计划', schedule: { dailyAt: '09:00' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { version: { schedule: { dailyAt: string; timezone: string } } };
    expect(body.version.schedule).toEqual({ dailyAt: '09:00', timezone: 'Asia/Shanghai' });
  });

  it('显式 IANA timezone → round trip', async () => {
    const { app } = createHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/daily-search-plans',
      payload: { name: '计划', schedule: { dailyAt: '08:30', timezone: 'Asia/Singapore' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { version: { schedule: { dailyAt: string; timezone: string } } };
    expect(body.version.schedule).toEqual({ dailyAt: '08:30', timezone: 'Asia/Singapore' });
  });

  it('非法 IANA timezone → 422', async () => {
    const { app } = createHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/daily-search-plans',
      payload: { name: '计划', schedule: { dailyAt: '09:00', timezone: 'Not/AZone' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
