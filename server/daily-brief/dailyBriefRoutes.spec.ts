import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION, runMigrations } from '../migrations';
import { RadarCaptureRepository } from '../radar/captureRepository';
import { RadarCandidateRepository } from '../radar/candidateRepository';
import { RadarRecommendationBatchRepository } from '../radar/recommendationBatchRepository';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { DailyBriefRepository } from './dailyBriefRepository';
import { registerDailyJobBriefRoutes } from './dailyBriefRoutes';
import type { DailyJobBrief } from './types';
import type { SearchCoverage } from '../search-provider/types';
import type { RadarCandidateNormalized, RadarRecommendationBatch } from '../../src/domain/radar';
import type { RecommendationItem, RecommendationSetV1 } from '../radar/recommendation/recommendationContract';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const NOW = Date.UTC(2026, 7, 14, 2, 0); // 2026-08-14 02:00 UTC = 10:00 Asia/Shanghai

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

/** 直接注册 brief 只读路由的 harness（可注入 now），不经过 buildServer。 */
function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-daily-brief-api-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  registerDailyJobBriefRoutes(app, { now: () => NOW });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

/** 经 buildServer（dailySearchPlan 开启）注册的 harness，验证生产 registration。 */
function createBuildServerHarness(options: { dailySearchPlanEnabled: boolean }): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-daily-brief-build-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
  const app = buildServer({
    db,
    dailySearchPlan: options.dailySearchPlanEnabled ? { enabled: true } : undefined,
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

function normalized(overrides: Partial<RadarCandidateNormalized> = {}): RadarCandidateNormalized {
  return {
    company: null, role: null, city: null, district: null, salaryMinK: null, salaryMaxK: null,
    salaryPeriod: null, experienceRequirement: null, educationRequirement: null, companySize: null,
    industry: null, jobNature: null, workMode: null, technicalStack: [], responsibilities: [],
    requirements: [], publishedAt: null, rawDescription: '',
    ...overrides,
  };
}

/** 铺设 plan + version（满足 daily_job_briefs.search_plan_version_id FK）。 */
function seedPlanVersion(db: SqliteDatabase): void {
  const repo = new SearchPlanRepository(db);
  repo.insertPlan({
    id: 'plan-1', name: '每日前端岗位', status: 'active', activeVersionId: null,
    createdAt: 1, updatedAt: 1, deletedAt: null,
  });
  repo.insertVersion({
    id: 'version-1', searchPlanId: 'plan-1', version: 1,
    cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [],
    hardConstraints: [], sourceConfigs: [],
    schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
    scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
    notificationPolicy: {}, latestCatchUpTime: '12:00',
    createdAt: 1, activatedAt: 1, supersedesVersionId: null,
  });
}

/** 铺设一个 capture snapshot（供 discovery 展开 sourceUrl/domain/provider）。 */
function seedSnapshot(
  db: SqliteDatabase,
  id: string,
  fields: { sourceUrl?: string; sourceDomain?: string; providerKey?: string } = {},
): void {
  new RadarCaptureRepository(db).insertSnapshot({
    id,
    captureSessionId: null,
    captureMethod: 'search_discovery',
    providerKey: fields.providerKey ?? 'tavily',
    providerVersion: '1.0.0',
    sourceDomain: fields.sourceDomain ?? 'zhipin.com',
    sourceUrl: fields.sourceUrl ?? 'https://www.zhipin.com/job/1',
    normalizedSourceUrl: fields.sourceUrl ?? 'https://www.zhipin.com/job/1',
    externalRecordId: null,
    pageTitle: null,
    visibleText: 'text',
    rawSnapshot: {},
    rawContentHash: `hash-${id}`,
    capturedAt: 1,
    createdAt: 1,
  });
}

/** 铺设 candidate + candidate version（discovery item 指向的 CandidateVersion）。 */
function seedCandidateVersion(
  db: SqliteDatabase,
  versionId: string,
  fields: { candidateId?: string; evidenceLevel?: string; snapshotId?: string; normalized?: Partial<RadarCandidateNormalized> } = {},
): void {
  const candidateId = fields.candidateId ?? 'cand-1';
  const repo = new RadarCandidateRepository(db);
  repo.insertCandidate({
    id: candidateId, primarySourceRecordId: null, activeVersionId: null,
    lifecycleStatus: 'active', mergedIntoCandidateId: null, createdAt: 1, updatedAt: 1,
  });
  repo.insertVersion({
    id: versionId,
    candidateId,
    versionNo: 1,
    normalized: normalized(fields.normalized),
    qualityIssues: [],
    sourceSnapshotIds: fields.snapshotId === undefined ? [] : [fields.snapshotId],
    contentHash: `hash-${versionId}`,
    originType: 'captured',
    evidenceLevel: (fields.evidenceLevel ?? 'SEARCH_EVIDENCE') as 'SEARCH_EVIDENCE',
    correctionNote: null,
    supersedesVersionId: null,
    createdAt: 1,
  });
}

/** 铺设一个推荐批次（empty 或 non-empty）。 */
function seedBatch(db: SqliteDatabase, id: string, mode: 'empty' | { recommendation: RecommendationItem }): void {
  const emptySet: RecommendationSetV1 = {
    contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_candidates_in_scope',
  };
  const nonEmptySet: RecommendationSetV1 = {
    contractVersion: 1, recommendations: [(mode as { recommendation: RecommendationItem }).recommendation],
    blocked: [], emptyReason: null,
  };
  const set = mode === 'empty' ? emptySet : nonEmptySet;
  const selected = set.recommendations.map((r) => r.candidateVersionId);
  const batch: RadarRecommendationBatch = {
    id,
    batchKey: `key-${id}`,
    status: 'succeeded',
    scope: { requestedCandidateVersionIds: selected, recommendationSet: set },
    candidateVersionIds: selected,
    selectedCandidateVersionIds: selected,
    profileVersions: {},
    ruleVersion: 'radar-recommendation:v1',
    recommendationRuleVersion: 'radar-recommendation:v1',
    analysisPolicyVersion: 'analysis-policy:v1',
    handledStateHash: `hash-${id}`,
    diagnosisStatus: 'insufficient_evidence',
    diagnosisPayload: null,
    emptyReason: set.emptyReason,
    generatedAt: 1,
    createdAt: 1,
  };
  new RadarRecommendationBatchRepository(db).insert(batch);
}

function seedBrief(db: SqliteDatabase, overrides: Partial<DailyJobBrief> = {}): DailyJobBrief {
  const brief: DailyJobBrief = {
    id: 'brief-1',
    briefDate: '2026-08-14',
    searchPlanVersionId: 'version-1',
    sourceRunIds: ['sr-1', 'sr-2'],
    recommendationBatchId: 'batch-1',
    discoveryItemIds: [],
    status: 'READY',
    coverage: { queriesCompleted: 1, queriesFailed: 0, failedScopes: [], queryResults: [] },
    costSummaryJson: null,
    emptyReason: null,
    generatedAt: 1,
    completedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  new DailyBriefRepository(db).insert(brief);
  return brief;
}

describe('DailyJobBrief 只读 API（T041）', () => {
  it('list 返回简报（含 total）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { briefs: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.briefs[0]?.id).toBe('brief-1');
  });

  it('get by id 返回单份简报', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { brief: { id: string; briefDate: string; searchPlanVersionId: string } };
    expect(body.brief.id).toBe('brief-1');
    expect(body.brief.briefDate).toBe('2026-08-14');
    expect(body.brief.searchPlanVersionId).toBe('version-1');
  });

  it('不存在的 brief → 404', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('recommendation 非空批次 → 返回非空推荐视图', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    const item: RecommendationItem = {
      candidateId: 'cand-1', candidateVersionId: 'ver-1', analysisRecordId: 'analysis-1',
      kind: 'apply_now', priority: 1, confidence: 'high', rationale: '合适',
      evidenceRefs: [], conditions: [],
    };
    seedBatch(db, 'batch-1', { recommendation: item });
    seedBrief(db, { recommendationBatchId: 'batch-1' });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as {
      recommendationBatch: { selectedCandidateVersionIds: string[]; recommendationSet: { recommendations: unknown[] } };
    };
    expect(body.recommendationBatch.selectedCandidateVersionIds).toEqual(['ver-1']);
    expect(body.recommendationBatch.recommendationSet.recommendations).toHaveLength(1);
  });

  it('显式空批次 → 返回 0 recommendations', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as {
      recommendationBatch: { selectedCandidateVersionIds: string[]; recommendationSet: { recommendations: unknown[] } };
    };
    expect(body.recommendationBatch.selectedCandidateVersionIds).toEqual([]);
    expect(body.recommendationBatch.recommendationSet.recommendations).toHaveLength(0);
  });

  it('discovery items 正确展开（候选版本身份 + 来源）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedSnapshot(db, 'snap-1', { sourceUrl: 'https://www.zhipin.com/job/42', sourceDomain: 'zhipin.com', providerKey: 'tavily' });
    seedCandidateVersion(db, 'ver-1', {
      candidateId: 'cand-1', evidenceLevel: 'SEARCH_EVIDENCE', snapshotId: 'snap-1',
      normalized: { role: '前端工程师', company: '某科技', city: '苏州' },
    });
    seedBrief(db, { discoveryItemIds: ['ver-1'] });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as {
      discoveryItems: Array<{ candidateId: string; candidateVersionId: string; evidenceLevel: string; title: string; company: string; city: string; sourceUrl: string; sourceDomain: string; provider: string }>;
    };
    expect(body.discoveryItems).toHaveLength(1);
    expect(body.discoveryItems[0]).toMatchObject({
      candidateId: 'cand-1',
      candidateVersionId: 'ver-1',
      evidenceLevel: 'SEARCH_EVIDENCE',
      title: '前端工程师',
      company: '某科技',
      city: '苏州',
      sourceUrl: 'https://www.zhipin.com/job/42',
      sourceDomain: 'zhipin.com',
      provider: 'tavily',
    });
  });

  it('sourceRunIds provenance 正确透出', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { sourceRunIds: ['sr-1', 'sr-2'] });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { sourceRunIds: string[] } };
    expect(body.brief.sourceRunIds).toEqual(['sr-1', 'sr-2']);
  });

  it('coverage 正确透出', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    const coverage: SearchCoverage = { queriesCompleted: 3, queriesFailed: 1, failedScopes: [{ queryKey: 'q1', errorCode: 'VALID_EMPTY', message: 'empty' }], queryResults: [] };
    seedBrief(db, { coverage });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { coverage: typeof coverage } };
    expect(body.brief.coverage).toEqual(coverage);
  });

  it('costSummaryJson=null 正确透出（尚未计算）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { costSummaryJson: null });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { costSummaryJson: null } };
    expect(body.brief.costSummaryJson).toBeNull();
  });

  it('emptyReason 正确透出', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { emptyReason: '今日未发现值得处理的新岗位' });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { emptyReason: string | null } };
    expect(body.brief.emptyReason).toBe('今日未发现值得处理的新岗位');
  });

  it('multi-run merged discovery 正确暴露（稳定顺序）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedSnapshot(db, 'snap-1');
    seedCandidateVersion(db, 'ver-a', { candidateId: 'cand-a' });
    seedCandidateVersion(db, 'ver-b', { candidateId: 'cand-b' });
    seedCandidateVersion(db, 'ver-c', { candidateId: 'cand-c' });
    seedBrief(db, { discoveryItemIds: ['ver-a', 'ver-b', 'ver-c'] });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { discoveryItemIds: string[] }; discoveryItems: Array<{ candidateVersionId: string }> };
    expect(body.brief.discoveryItemIds).toEqual(['ver-a', 'ver-b', 'ver-c']);
    expect(body.discoveryItems.map((d) => d.candidateVersionId)).toEqual(['ver-a', 'ver-b', 'ver-c']);
  });

  it('multi-run monotonic recommendation 正确暴露', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    const item: RecommendationItem = {
      candidateId: 'cand-1', candidateVersionId: 'ver-1', analysisRecordId: 'analysis-1',
      kind: 'apply_now', priority: 1, confidence: 'high', rationale: '合适',
      evidenceRefs: [], conditions: [],
    };
    seedBatch(db, 'batch-nonempty', { recommendation: item });
    seedBrief(db, { recommendationBatchId: 'batch-nonempty', discoveryItemIds: ['ver-1'], emptyReason: null });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { recommendationBatchId: string; emptyReason: string | null }; recommendationBatch: { selectedCandidateVersionIds: string[] } };
    expect(body.brief.recommendationBatchId).toBe('batch-nonempty');
    expect(body.brief.emptyReason).toBeNull();
    expect(body.recommendationBatch.selectedCandidateVersionIds).toEqual(['ver-1']);
  });

  it('非法 id → 422', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/   ' });
    expect(res.statusCode).toBe(422);
  });

  it('today 返回当日简报（默认 Asia/Shanghai 自然日）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { briefDate: '2026-08-14' });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/today' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { briefDate: string; total: number };
    expect(body.briefDate).toBe('2026-08-14');
    expect(body.total).toBe(1);
  });

  it('生产 buildServer registration：dailySearchPlan 开启 → 路由注册，关闭 → 404', async () => {
    const on = createBuildServerHarness({ dailySearchPlanEnabled: true });
    const off = createBuildServerHarness({ dailySearchPlanEnabled: false });
    const onRes = await on.app.inject({ method: 'GET', url: '/daily-job-briefs' });
    const offRes = await off.app.inject({ method: 'GET', url: '/daily-job-briefs' });
    expect(onRes.statusCode).toBe(200);
    expect(offRes.statusCode).toBe(404);
  });

  it('读 API 不触发 Pipeline/Analysis/Recommendation 写入', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { discoveryItemIds: [] });

    const batchCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM radar_recommendation_batches').get() as { c: number }).c;
    const analysisTaskCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM analysis_tasks').get() as { c: number }).c;
    const briefCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM daily_job_briefs').get() as { c: number }).c;

    await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });

    const batchCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM radar_recommendation_batches').get() as { c: number }).c;
    const analysisTaskCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM analysis_tasks').get() as { c: number }).c;
    const briefCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM daily_job_briefs').get() as { c: number }).c;

    expect(batchCountAfter).toBe(batchCountBefore);
    expect(analysisTaskCountAfter).toBe(analysisTaskCountBefore);
    expect(briefCountAfter).toBe(briefCountBefore);
  });

  // ── T041 identity hardening：推荐岗位身份 + plan label + 多 Brief ─────────────

  it('recommendation item 展开岗位身份（role/company/city/evidenceLevel）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedSnapshot(db, 'snap-1', { sourceUrl: 'https://www.zhipin.com/job/42', sourceDomain: 'zhipin.com', providerKey: 'boss' });
    seedCandidateVersion(db, 'ver-1', {
      candidateId: 'cand-1', evidenceLevel: 'FULL_EVIDENCE', snapshotId: 'snap-1',
      normalized: { role: '前端工程师', company: '某科技', city: '苏州' },
    });
    const item: RecommendationItem = {
      candidateId: 'cand-1', candidateVersionId: 'ver-1', analysisRecordId: 'analysis-1',
      kind: 'apply_now', priority: 1, confidence: 'high', rationale: '合适',
      evidenceRefs: [{ evidenceKey: 'skill_match', polarity: 'support' }], conditions: ['verify_before_apply'],
    };
    seedBatch(db, 'batch-1', { recommendation: item });
    seedBrief(db, { recommendationBatchId: 'batch-1' });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as {
      recommendationItems: Array<{
        candidateId: string; candidateVersionId: string; evidenceLevel: string;
        title: string | null; company: string | null; city: string | null;
        sourceUrl: string | null; sourceDomain: string | null; provider: string | null;
        kind: string; priority: number; confidence: string; rationale: string;
      }>;
    };
    expect(body.recommendationItems).toHaveLength(1);
    expect(body.recommendationItems[0]).toMatchObject({
      candidateId: 'cand-1',
      candidateVersionId: 'ver-1',
      evidenceLevel: 'FULL_EVIDENCE',
      title: '前端工程师',
      company: '某科技',
      city: '苏州',
      sourceUrl: 'https://www.zhipin.com/job/42',
      sourceDomain: 'zhipin.com',
      provider: 'boss',
      kind: 'apply_now',
      priority: 1,
      confidence: 'high',
      rationale: '合适',
    });
  });

  it('recommendation item 按 candidateVersionId 精确展开（不用 active/latest 版本）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    // 同一候选 cand-1 有两个版本：ver-old（旧 active）、ver-2（被推荐精确引用）。
    const repo = new RadarCandidateRepository(db);
    repo.insertCandidate({
      id: 'cand-1', primarySourceRecordId: null, activeVersionId: null,
      lifecycleStatus: 'active', mergedIntoCandidateId: null, createdAt: 1, updatedAt: 1,
    });
    repo.insertVersion({
      id: 'ver-old', candidateId: 'cand-1', versionNo: 1,
      normalized: normalized({ role: '旧岗位', company: '旧公司', city: '旧城' }),
      qualityIssues: [], sourceSnapshotIds: [], contentHash: 'hash-ver-old',
      originType: 'captured', evidenceLevel: 'FULL_EVIDENCE', correctionNote: null,
      supersedesVersionId: null, createdAt: 1,
    });
    repo.insertVersion({
      id: 'ver-2', candidateId: 'cand-1', versionNo: 2,
      normalized: normalized({ role: '新岗位', company: '新公司', city: '苏州' }),
      qualityIssues: [], sourceSnapshotIds: [], contentHash: 'hash-ver-2',
      originType: 'source_change', evidenceLevel: 'FULL_EVIDENCE', correctionNote: null,
      supersedesVersionId: 'ver-old', createdAt: 2,
    });
    // 把 active 指向 ver-old：证明展示身份不是猜 active/latest，而是精确按 candidateVersionId。
    repo.setActiveVersionId('cand-1', 'ver-old', 2);
    const item: RecommendationItem = {
      candidateId: 'cand-1', candidateVersionId: 'ver-2', analysisRecordId: 'analysis-2',
      kind: 'stretch', priority: 1, confidence: 'medium', rationale: '冲刺',
      evidenceRefs: [], conditions: [],
    };
    seedBatch(db, 'batch-1', { recommendation: item });
    seedBrief(db, { recommendationBatchId: 'batch-1' });
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { recommendationItems: Array<{ candidateVersionId: string; title: string | null; company: string | null }> };
    expect(body.recommendationItems).toHaveLength(1);
    // 精确命中被推荐分析的 ver-2，而不是 activeVersionId 指向的 ver-old。
    expect(body.recommendationItems[0].candidateVersionId).toBe('ver-2');
    expect(body.recommendationItems[0].title).toBe('新岗位');
    expect(body.recommendationItems[0].company).toBe('新公司');
  });

  it('显式空批次 → recommendationItems = []（不破坏空批语义）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db);
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { recommendationItems: unknown[] };
    expect(body.recommendationItems).toEqual([]);
  });

  it('多简报（多计划版本）each 带 plan label（searchPlan.name 而非 UUID）', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    // 第二个 plan + version
    const planRepo = new SearchPlanRepository(db);
    planRepo.insertPlan({
      id: 'plan-2', name: '后端岗位计划', status: 'active', activeVersionId: null,
      createdAt: 2, updatedAt: 2, deletedAt: null,
    });
    planRepo.insertVersion({
      id: 'version-2', searchPlanId: 'plan-2', version: 1,
      cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [],
      hardConstraints: [], sourceConfigs: [],
      schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
      scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
      notificationPolicy: {}, latestCatchUpTime: '12:00',
      createdAt: 2, activatedAt: 2, supersedesVersionId: null,
    });
    seedBatch(db, 'batch-1', 'empty');
    seedBatch(db, 'batch-2', 'empty');
    seedBrief(db, { id: 'brief-1', searchPlanVersionId: 'version-1', recommendationBatchId: 'batch-1' });
    seedBrief(db, { id: 'brief-2', searchPlanVersionId: 'version-2', recommendationBatchId: 'batch-2' });

    const today = await app.inject({ method: 'GET', url: '/daily-job-briefs/today' });
    const body = today.json() as {
      total: number;
      briefs: Array<{ id: string; searchPlanVersionId: string; searchPlan: { id: string; name: string; versionId: string } | null }>;
    };
    expect(body.total).toBe(2);
    const byId = new Map(body.briefs.map((b) => [b.id, b]));
    expect(byId.get('brief-1')?.searchPlan).toEqual({ id: 'plan-1', name: '每日前端岗位', versionId: 'version-1' });
    expect(byId.get('brief-2')?.searchPlan).toEqual({ id: 'plan-2', name: '后端岗位计划', versionId: 'version-2' });
  });

  it('historical 旧 PlanVersion 正确解析 plan（不依赖当前 activeVersionId）', async () => {
    const { app, db } = createHarness();
    const planRepo = new SearchPlanRepository(db);
    planRepo.insertPlan({
      id: 'plan-1', name: '每日前端岗位', status: 'active', activeVersionId: null,
      createdAt: 1, updatedAt: 1, deletedAt: null,
    });
    planRepo.insertVersion({
      id: 'version-1', searchPlanId: 'plan-1', version: 1,
      cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [],
      hardConstraints: [], sourceConfigs: [],
      schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
      scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
      notificationPolicy: {}, latestCatchUpTime: '12:00',
      createdAt: 1, activatedAt: 1, supersedesVersionId: null,
    });
    planRepo.insertVersion({
      id: 'version-2', searchPlanId: 'plan-1', version: 2,
      cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [],
      hardConstraints: [], sourceConfigs: [],
      schedule: { dailyAt: '09:30', timezone: 'Asia/Shanghai' },
      scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
      notificationPolicy: {}, latestCatchUpTime: '12:00',
      createdAt: 2, activatedAt: 2, supersedesVersionId: 'version-1',
    });
    planRepo.setActiveVersion('plan-1', 'version-2'); // 当前 active 是 version-2
    seedBatch(db, 'batch-1', 'empty');
    seedBrief(db, { searchPlanVersionId: 'version-1' }); // brief 引用旧 version-1
    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/brief-1' });
    const body = res.json() as { brief: { searchPlanVersionId: string; searchPlan: { id: string; name: string; versionId: string } | null } };
    // 通过 version-1.searchPlanId 精确解析，而不是 plan.activeVersionId(version-2)。
    expect(body.brief.searchPlanVersionId).toBe('version-1');
    expect(body.brief.searchPlan).toEqual({ id: 'plan-1', name: '每日前端岗位', versionId: 'version-1' });
  });

  it('GET /daily-job-briefs/date/:date 返回指定日期的简报列表', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);
    seedBatch(db, 'batch-1', 'empty');
    seedBatch(db, 'batch-2', 'empty');
    seedBrief(db, { id: 'brief-1', briefDate: '2026-08-14', recommendationBatchId: 'batch-1' });
    seedBrief(db, { id: 'brief-2', briefDate: '2026-08-13', recommendationBatchId: 'batch-2' });

    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/date/2026-08-14' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { briefDate: string; briefs: DailyJobBrief[]; total: number };
    expect(body.briefDate).toBe('2026-08-14');
    expect(body.total).toBe(1);
    expect(body.briefs).toHaveLength(1);
    expect(body.briefs[0].id).toBe('brief-1');
  });

  it('GET /daily-job-briefs/date/:date 返回空列表当日期无简报', async () => {
    const { app, db } = createHarness();
    seedPlanVersion(db);

    const res = await app.inject({ method: 'GET', url: '/daily-job-briefs/date/2026-08-20' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { briefDate: string; briefs: DailyJobBrief[]; total: number };
    expect(body.briefDate).toBe('2026-08-20');
    expect(body.total).toBe(0);
    expect(body.briefs).toHaveLength(0);
  });

  it('GET /daily-job-briefs/date/:date 拒绝非法日期格式', async () => {
    const { app } = createHarness();

    const res1 = await app.inject({ method: 'GET', url: '/daily-job-briefs/date/2026-8-14' });
    expect(res1.statusCode).toBe(422);

    const res2 = await app.inject({ method: 'GET', url: '/daily-job-briefs/date/20260814' });
    expect(res2.statusCode).toBe(422);

    const res3 = await app.inject({ method: 'GET', url: '/daily-job-briefs/date/invalid' });
    expect(res3.statusCode).toBe(422);
  });
});
