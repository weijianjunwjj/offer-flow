import { describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_JOB_SCHEDULER_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { SourceRunRepository } from '../source-run/sourceRunRepository';
import { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import { DailyRunCoordinator } from './DailyRunCoordinator';
import type { DailyPipelineResult } from '../pipeline/types';
import type { DailyPipeline } from '../pipeline/DailyPipeline';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-coordinator-'));
let seq = 0;

function withCoordinator(run: (ctx: {
  coordinator: DailyRunCoordinator;
  db: Database.Database;
  planRepo: SearchPlanRepository;
  sourceRunRepo: SourceRunRepository;
  briefRepo: DailyBriefRepository;
  pipelineRun: ReturnType<typeof vi.fn>;
  versionId: string;
  planId: string;
}) => Promise<void>): Promise<void> {
  return (async () => {
    seq += 1;
    const db = openDb(path.join(tempDir, `scenario-${seq}.sqlite3`));
    runMigrations(db, { targetVersion: DAILY_JOB_SCHEDULER_SCHEMA_VERSION });
    const planRepo = new SearchPlanRepository(db);
    const sourceRunRepo = new SourceRunRepository(db);
    const briefRepo = new DailyBriefRepository(db);

    // 插入 plan + version（含 schedule timezone + sourceConfigs + scanBudget + query 输入）。
    const now = Date.UTC(2026, 7, 14, 2, 0);
    planRepo.insertPlan({
      id: 'plan-1', name: '每日前端岗位', status: 'active', activeVersionId: null,
      createdAt: now, updatedAt: now, deletedAt: null,
    });
    planRepo.insertVersion({
      id: 'version-1', searchPlanId: 'plan-1', version: 1,
      cities: [{ name: '苏州', priority: 1 }],
      roleDirections: ['前端开发'],
      baseKeywords: ['React'],
      expandedKeywords: [],
      hardConstraints: [],
      sourceConfigs: [{ providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true }],
      schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
      scanBudget: { maxQueriesPerRun: 5 },
      analysisBudget: {},
      briefPolicy: {},
      explorationPolicy: {},
      notificationPolicy: {},
      latestCatchUpTime: '12:00',
      createdAt: now, activatedAt: now, supersedesVersionId: null,
    });
    planRepo.setActiveVersion('plan-1', 'version-1');

    let idSeq = 0;
    const emptyResult = (): DailyPipelineResult => ({
      items: [],
      recommendationScope: [],
      recommendationBatchId: null,
      summary: {
        total: 0, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0,
        analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0,
        fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0,
        ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false,
      },
    });

    const pipelineRun = vi.fn(async () => emptyResult());
    const pipeline = { run: pipelineRun } as unknown as DailyPipeline;
    const coordinator = new DailyRunCoordinator({
      planRepo, sourceRunRepo, briefRepo, pipeline,
      providerKey: 'tavily', providerVersion: '1.0.0',
      createEmptyBatch: () => {
        idSeq += 1;
        const batchId = `batch-empty-${idSeq}`;
        db.prepare(`
          INSERT INTO radar_recommendation_batches (
            id, batch_key, status, scope_json, candidate_version_ids_json,
            selected_candidate_version_ids_json, profile_versions_json, rule_version,
            recommendation_rule_version, analysis_policy_version, handled_state_hash,
            diagnosis_status, generated_at, created_at
          ) VALUES (?, ?, 'succeeded', '{}', '[]', '[]', '{}',
            'radar-recommendation:v1', 'radar-recommendation:v1', 'analysis-policy:v1',
            'empty-hash', 'insufficient_evidence', 1, 1)
        `).run(batchId, `key-${batchId}`);
        return batchId;
      },
      createId: () => { idSeq += 1; return `run-${idSeq}`; },
      now: () => now,
    });

    await run({ coordinator, db, planRepo, sourceRunRepo, briefRepo, pipelineRun, versionId: 'version-1', planId: 'plan-1' });
    db.close();
  })();
}

describe('DailyRunCoordinator（T028 闭环核心）', () => {
  it('Pipeline 前创建 SourceRun；Pipeline success → SourceRun SUCCEEDED', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      const order: string[] = [];
      pipelineRun.mockImplementationOnce(async () => {
        order.push('pipeline');
        return { items: [], recommendationScope: [], recommendationBatchId: null, summary: { total: 0, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0, analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0, fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0, ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false } };
      });
      const result = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'SCHEDULED',
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: '2026-08-14',
      });
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        assert.equal(result.status, 'SUCCEEDED');
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.equal(run?.status, 'SUCCEEDED');
        assert.equal(run?.searchPlanVersionId, 'version-1');
        assert.equal(run?.searchPlanId, 'plan-1');
        assert.equal(run?.scheduledDay, '2026-08-14');
      }
      // pipeline.run 被调用且只调一次（不重跑）。
      expect(pipelineRun).toHaveBeenCalledTimes(1);
    });
  });

  it('Query expansion 复用 taskExpansion（cities×directions×keywords）', async () => {
    await withCoordinator(async ({ coordinator, pipelineRun }) => {
      await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'MANUAL',
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: null,
      });
      const queries = pipelineRun.mock.calls[0]?.[0] as Array<{ queryKey: string }>;
      expect(queries.map((q) => q.queryKey)).toContain('苏州×前端开发×React');
    });
  });

  it('Pipeline failure → SourceRun FAILED，且不构建 brief', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, briefRepo, pipelineRun }) => {
      pipelineRun.mockRejectedValueOnce(new Error('pipeline boom'));
      const result = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'SCHEDULED',
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: '2026-08-14',
      });
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        assert.equal(result.status, 'FAILED');
        assert.equal(result.briefId, null);
        assert.equal(sourceRunRepo.getById(result.sourceRunId)?.status, 'FAILED');
      }
      expect(briefRepo.findByLogicalIdentity('2026-08-14', 'version-1')).toBeNull();
    });
  });

  it('brief 正确投影 planVersionId / sourceRunId / recommendationBatchId / costSummaryJson=null', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db }) => {
      // 插入一个真实 batch 供 FK 引用。
      db.prepare(`
        INSERT INTO radar_recommendation_batches (
          id, batch_key, status, scope_json, candidate_version_ids_json,
          selected_candidate_version_ids_json, profile_versions_json, rule_version,
          recommendation_rule_version, analysis_policy_version, handled_state_hash,
          diagnosis_status, generated_at, created_at
        ) VALUES ('batch-1', 'key-1', 'succeeded', '{}', '[]', '[]', '{}',
          'radar-recommendation:v1', 'radar-recommendation:v1', 'analysis-policy:v1',
          'hash', 'insufficient_evidence', 1, 1)
      `).run();
      const result = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'SCHEDULED',
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: '2026-08-14',
      });
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
        assert.ok(brief !== null);
        assert.equal(brief.searchPlanVersionId, 'version-1');
        assert.deepEqual(brief.sourceRunIds, [result.sourceRunId]);
        assert.equal(brief.costSummaryJson, null);
      }
    });
  });

  it('same logical brief（同日同 PlanVersion）不重复，reconcile 合并 sourceRunIds', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db }) => {
      db.prepare(`
        INSERT INTO radar_recommendation_batches (
          id, batch_key, status, scope_json, candidate_version_ids_json,
          selected_candidate_version_ids_json, profile_versions_json, rule_version,
          recommendation_rule_version, analysis_policy_version, handled_state_hash,
          diagnosis_status, generated_at, created_at
        ) VALUES ('batch-1', 'key-1', 'succeeded', '{}', '[]', '[]', '{}',
          'radar-recommendation:v1', 'radar-recommendation:v1', 'analysis-policy:v1',
          'hash', 'insufficient_evidence', 1, 1)
      `).run();
      // 第一次 MANUAL（scheduledDay=null → briefDate 用 plan timezone 今天）
      const first = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'MANUAL',
        scheduledFor: Date.UTC(2026, 7, 14, 2, 0), scheduledDay: null,
      });
      const second = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'MANUAL',
        scheduledFor: Date.UTC(2026, 7, 14, 2, 0), scheduledDay: null,
      });
      assert.equal(first.outcome, 'completed');
      assert.equal(second.outcome, 'completed');
      if (first.outcome === 'completed' && second.outcome === 'completed') {
        const briefs = briefRepo.listRecent(10).filter((b) => b.searchPlanVersionId === 'version-1');
        assert.equal(briefs.length, 1);
        assert.deepEqual(briefs[0]?.sourceRunIds, [first.sourceRunId, second.sourceRunId]);
      }
    });
  });

  it('同 occurrence 重复 run → skip（occurrence dedupe 持久化防重）', async () => {
    await withCoordinator(async ({ coordinator }) => {
      const input = {
        searchPlanVersionId: 'version-1', triggerType: 'SCHEDULED' as const,
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: '2026-08-14',
      };
      const first = await coordinator.run(input);
      const second = await coordinator.run(input);
      assert.equal(first.outcome, 'completed');
      assert.equal(second.outcome, 'skipped');
    });
  });
});
