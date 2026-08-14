import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import { RadarRecommendationBatchRepository } from '../radar/recommendationBatchRepository';
import { SourceRunRepository } from './sourceRunRepository';
import type { SourceRun } from './types';
import { registerSourceRunRoutes } from './sourceRunRoutes';
import type { RadarRecommendationBatch } from '../../src/domain/radar';
import type { RecommendationSetV1 } from '../radar/recommendation/recommendationContract';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

/** 直接注册 SourceRun 只读路由的 harness（不经 buildServer）。 */
function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-source-run-api-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  registerSourceRunRoutes(app);
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

/** 经 buildServer（dailySearchPlan 开启）注册的 harness，验证生产 registration。 */
function createBuildServerHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-source-run-build-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  const app = buildServer({ db, dailySearchPlan: { enabled: true } });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

/** 铺设 plan + version（满足 source_runs.search_plan_version_id 外键）。 */
function seedPlanVersion(db: SqliteDatabase, planId: string, planName: string, versionId: string): void {
  const repo = new SearchPlanRepository(db);
  repo.insertPlan({
    id: planId, name: planName, status: 'active', activeVersionId: null,
    createdAt: 1, updatedAt: 1, deletedAt: null,
  });
  repo.insertVersion({
    id: versionId, searchPlanId: planId, version: 1,
    cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [],
    hardConstraints: [], sourceConfigs: [],
    schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
    scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
    notificationPolicy: {}, latestCatchUpTime: '12:00',
    createdAt: 1, activatedAt: 1, supersedesVersionId: null,
  });
}

/** 铺设一个空推荐批次（满足 daily_job_briefs.recommendation_batch_id 外键）。 */
function seedEmptyBatch(db: SqliteDatabase, id: string): void {
  const emptySet: RecommendationSetV1 = {
    contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_candidates_in_scope',
  };
  const batch: RadarRecommendationBatch = {
    id,
    batchKey: `key-${id}`,
    status: 'succeeded',
    scope: { requestedCandidateVersionIds: [], recommendationSet: emptySet },
    candidateVersionIds: [],
    selectedCandidateVersionIds: [],
    profileVersions: {},
    ruleVersion: 'radar-recommendation:v1',
    recommendationRuleVersion: 'radar-recommendation:v1',
    analysisPolicyVersion: 'analysis-policy:v1',
    handledStateHash: `hash-${id}`,
    diagnosisStatus: 'insufficient_evidence',
    diagnosisPayload: null,
    emptyReason: emptySet.emptyReason,
    generatedAt: 1,
    createdAt: 1,
  };
  new RadarRecommendationBatchRepository(db).insert(batch);
}

function makeRun(overrides: Partial<SourceRun> = {}): SourceRun {
  return {
    id: 'run-1',
    searchPlanId: 'plan-1',
    searchPlanVersionId: 'version-1',
    scheduledDay: null,
    sourceKey: 'tavily',
    sourceVersion: '1.0.0',
    triggerType: 'SCHEDULED',
    retryOfRunId: null,
    status: 'PENDING',
    phase: 'PREPARING',
    scheduledFor: 1000,
    startedAt: null,
    finishedAt: null,
    queriesAttempted: 0,
    queriesSucceeded: 0,
    queriesFailed: 0,
    resultsDiscovered: 0,
    relevantResults: 0,
    newCount: 0,
    changedCount: 0,
    duplicateCount: 0,
    conflictCount: 0,
    blockedCount: 0,
    searchEvidencePersisted: 0,
    manualReviewRequired: 0,
    fullEvidenceCount: 0,
    analysisEligibleCount: 0,
    analysisRequestedCount: 0,
    analysisSucceededCount: 0,
    selectedCount: 0,
    alertedCount: 0,
    failedCount: 0,
    estimatedSearchCredits: null,
    actualSearchCredits: null,
    coverage: { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] },
    progressJson: {},
    costSummaryJson: {},
    errorCode: null,
    errorMessage: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('SourceRun 只读观测 API（T030）', () => {
  it('list 返回 SourceRun（含 plan identity 与 provenance）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({
      status: 'SUCCEEDED', startedAt: 100, finishedAt: 200, phase: 'BUILDING_BRIEF',
    }));
    const res = await app.inject({ method: 'GET', url: '/source-runs' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe('run-1');
    expect(body.runs[0].searchPlanId).toBe('plan-1');
    expect(body.runs[0].searchPlanVersionId).toBe('version-1');
    expect(body.runs[0].searchPlan).toEqual({ id: 'plan-1', name: '每日前端岗位', versionId: 'version-1' });
    expect(body.runs[0].status).toBe('SUCCEEDED');
    expect(body.runs[0].phase).toBe('BUILDING_BRIEF');
  });

  it('list 有界：默认 50 条，limit 参数生效', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    const repo = new SourceRunRepository(db);
    for (let i = 1; i <= 55; i += 1) {
      repo.insert(makeRun({
        id: `run-${i}`,
        triggerType: 'MANUAL',
        status: 'SUCCEEDED',
        scheduledFor: 1000 + i,
        scheduledDay: null,
        createdAt: 100 + i,
        updatedAt: 100 + i,
      }));
    }
    const defaultList = await app.inject({ method: 'GET', url: '/source-runs' });
    expect(defaultList.json().runs).toHaveLength(50);

    const limited = await app.inject({ method: 'GET', url: '/source-runs?limit=3' });
    expect(limited.json().runs).toHaveLength(3);
  });

  it('get by id 返回详情（含 dailyBrief 关联）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({ status: 'SUCCEEDED', startedAt: 100, finishedAt: 200 }));
    seedEmptyBatch(db, 'batch-1');
    new DailyBriefRepository(db).insert({
      id: 'brief-1',
      briefDate: '2026-08-14',
      searchPlanVersionId: 'version-1',
      sourceRunIds: ['run-1'],
      recommendationBatchId: 'batch-1',
      discoveryItemIds: [],
      status: 'READY',
      coverage: { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] },
      costSummaryJson: null,
      emptyReason: null,
      generatedAt: 200,
      completedAt: null,
      createdAt: 200,
      updatedAt: 200,
    });
    const res = await app.inject({ method: 'GET', url: '/source-runs/run-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.id).toBe('run-1');
    expect(body.dailyBrief).toEqual({ id: 'brief-1', briefDate: '2026-08-14', status: 'READY' });
  });

  it('get by id 不存在返回 404', async () => {
    const { app } = createHarness();
    const res = await app.inject({ method: 'GET', url: '/source-runs/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('scheduled / catch-up / manual 三种 trigger 均透出', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    const repo = new SourceRunRepository(db);
    repo.insert(makeRun({ id: 'run-s', triggerType: 'SCHEDULED', scheduledDay: '2026-08-14', scheduledFor: 1000, status: 'SUCCEEDED' }));
    repo.insert(makeRun({ id: 'run-c', triggerType: 'CATCH_UP', scheduledDay: '2026-08-13', scheduledFor: 2000, status: 'SUCCEEDED' }));
    repo.insert(makeRun({ id: 'run-m', triggerType: 'MANUAL', scheduledDay: null, scheduledFor: 3000, status: 'SUCCEEDED' }));
    const res = await app.inject({ method: 'GET', url: '/source-runs' });
    const runs = res.json().runs as Array<{ id: string; triggerType: string }>;
    expect(new Set(runs.map((r) => r.triggerType))).toEqual(new Set(['SCHEDULED', 'CATCH_UP', 'MANUAL']));
  });

  it('retry provenance：retryOfRunId 透出', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    const repo = new SourceRunRepository(db);
    repo.insert(makeRun({ id: 'run-1', status: 'FAILED', errorCode: 'PIPELINE_FAILED' }));
    repo.insert(makeRun({ id: 'run-2', triggerType: 'RETRY', retryOfRunId: 'run-1', status: 'RUNNING' }));
    const res = await app.inject({ method: 'GET', url: '/source-runs/run-2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.retryOfRunId).toBe('run-1');
    expect(res.json().run.triggerType).toBe('RETRY');
  });

  it('failed run 透出 errorCode / errorMessage（failure observability）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({
      status: 'FAILED',
      phase: 'DISCOVERING',
      errorCode: 'PIPELINE_FAILED',
      errorMessage: 'search provider timeout',
    }));
    const res = await app.inject({ method: 'GET', url: '/source-runs/run-1' });
    const run = res.json().run;
    expect(run.status).toBe('FAILED');
    expect(run.errorCode).toBe('PIPELINE_FAILED');
    expect(run.errorMessage).toBe('search provider timeout');
  });

  it('running 状态与 phase 透出真实持久化值', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({ status: 'RUNNING', phase: 'DISCOVERING', startedAt: 100 }));
    const res = await app.inject({ method: 'GET', url: '/source-runs/run-1' });
    const run = res.json().run;
    expect(run.status).toBe('RUNNING');
    expect(run.phase).toBe('DISCOVERING');
    expect(run.startedAt).toBe(100);
    expect(run.finishedAt).toBeNull();
  });

  it('历史 PlanVersion label 正确（每个 run 解析到自己的 plan name）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-a', '前端岗位计划', 'version-a');
    seedPlanVersion(db, 'plan-b', '后端岗位计划', 'version-b');
    const repo = new SourceRunRepository(db);
    repo.insert(makeRun({
      id: 'run-a', searchPlanId: 'plan-a', searchPlanVersionId: 'version-a',
      status: 'SUCCEEDED', scheduledFor: 1000,
    }));
    repo.insert(makeRun({
      id: 'run-b', searchPlanId: 'plan-b', searchPlanVersionId: 'version-b',
      status: 'SUCCEEDED', scheduledFor: 2000,
    }));
    const resA = await app.inject({ method: 'GET', url: '/source-runs/run-a' });
    expect(resA.json().run.searchPlan).toEqual({ id: 'plan-a', name: '前端岗位计划', versionId: 'version-a' });
    const resB = await app.inject({ method: 'GET', url: '/source-runs/run-b' });
    expect(resB.json().run.searchPlan).toEqual({ id: 'plan-b', name: '后端岗位计划', versionId: 'version-b' });
  });

  it('filter by planId / status / day', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-a', '前端岗位计划', 'version-a');
    seedPlanVersion(db, 'plan-b', '后端岗位计划', 'version-b');
    const repo = new SourceRunRepository(db);
    repo.insert(makeRun({ id: 'a-succ', searchPlanId: 'plan-a', searchPlanVersionId: 'version-a', status: 'SUCCEEDED', scheduledFor: 1000 }));
    repo.insert(makeRun({ id: 'a-fail', searchPlanId: 'plan-a', searchPlanVersionId: 'version-a', status: 'FAILED', scheduledFor: 2000 }));
    repo.insert(makeRun({ id: 'b-succ', searchPlanId: 'plan-b', searchPlanVersionId: 'version-b', status: 'SUCCEEDED', scheduledFor: 3000, scheduledDay: '2026-08-13' }));

    const byPlan = await app.inject({ method: 'GET', url: '/source-runs?planId=plan-a' });
    expect(byPlan.json().runs.map((r: { id: string }) => r.id).sort()).toEqual(['a-fail', 'a-succ']);

    const byStatus = await app.inject({ method: 'GET', url: '/source-runs?status=FAILED' });
    expect(byStatus.json().runs.map((r: { id: string }) => r.id)).toEqual(['a-fail']);

    const byDay = await app.inject({ method: 'GET', url: '/source-runs?day=2026-08-13' });
    expect(byDay.json().runs.map((r: { id: string }) => r.id)).toEqual(['b-succ']);
  });

  it('coverage 安全投影：不透出 provider error message / queryResults', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({
      status: 'SUCCEEDED',
      coverage: {
        queriesCompleted: 2,
        queriesFailed: 1,
        failedScopes: [{ queryKey: '苏州×前端', errorCode: 'VALID_EMPTY', message: 'provider secret detail' }],
        queryResults: [{ queryKey: '苏州×前端', status: 'FAILED', resultsReturned: 0, errorMessage: 'secret' }],
      },
    }));
    const res = await app.inject({ method: 'GET', url: '/source-runs/run-1' });
    const coverage = res.json().run.coverage;
    expect(coverage).toEqual({
      queriesCompleted: 2,
      queriesFailed: 1,
      failedScopes: [{ queryKey: '苏州×前端', errorCode: 'VALID_EMPTY' }],
    });
    expect(JSON.stringify(coverage)).not.toContain('secret');
  });

  it('validation：非法 status / triggerType / day / limit 返回 422', async () => {
    const { app } = createHarness();
    const badStatus = await app.inject({ method: 'GET', url: '/source-runs?status=BOGUS' });
    expect(badStatus.statusCode).toBe(422);
    const badTrigger = await app.inject({ method: 'GET', url: '/source-runs?triggerType=BOGUS' });
    expect(badTrigger.statusCode).toBe(422);
    const badDay = await app.inject({ method: 'GET', url: '/source-runs?day=not-a-date' });
    expect(badDay.statusCode).toBe(422);
    const badLimit = await app.inject({ method: 'GET', url: '/source-runs?limit=0' });
    expect(badLimit.statusCode).toBe(422);
  });

  it('read-only 安全：GET 不产生任何写副作用', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({ status: 'SUCCEEDED', startedAt: 100, finishedAt: 200 }));
    seedEmptyBatch(db, 'batch-1');
    new DailyBriefRepository(db).insert({
      id: 'brief-1', briefDate: '2026-08-14', searchPlanVersionId: 'version-1',
      sourceRunIds: ['run-1'], recommendationBatchId: 'batch-1', discoveryItemIds: [],
      status: 'READY', coverage: { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] },
      costSummaryJson: null, emptyReason: null, generatedAt: 200, completedAt: null, createdAt: 200, updatedAt: 200,
    });
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    const runsBefore = count('source_runs');
    const briefsBefore = count('daily_job_briefs');

    await app.inject({ method: 'GET', url: '/source-runs' });
    await app.inject({ method: 'GET', url: '/source-runs/run-1' });

    expect(count('source_runs')).toBe(runsBefore);
    expect(count('daily_job_briefs')).toBe(briefsBefore);
  });

  it('生产 registration：经 buildServer(dailySearchPlan) 可访问', async () => {
    const { app, db } = createBuildServerHarness();
    seedPlanVersion(db, 'plan-1', '每日前端岗位', 'version-1');
    new SourceRunRepository(db).insert(makeRun({ status: 'SUCCEEDED', startedAt: 100, finishedAt: 200 }));
    const res = await app.inject({ method: 'GET', url: '/source-runs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs).toHaveLength(1);
  });
});
