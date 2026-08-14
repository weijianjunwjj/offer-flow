import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { SkipRepository } from '../search-plan/skipRepository';
import { SourceRunRepository } from '../source-run/sourceRunRepository';
import { DailyBriefRepository } from '../daily-brief/dailyBriefRepository';
import { DailyRunCoordinator } from '../daily-run/DailyRunCoordinator';
import { DailyJobScheduler } from './DailyJobScheduler';
import type { DailyPipelineResult } from '../pipeline/types';
import type { DailyPipeline } from '../pipeline/DailyPipeline';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-integration-'));
let seq = 0;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Integration smoke：真实 repository + 真实 Scheduler/Coordinator wiring + controlled fake
 * pipeline（外部 Tavily/LLM 边界 fake），证明 Scheduler → Coordinator → Pipeline → SourceRun
 * → DailyBrief 链可以闭环。
 */
describe('T028 integration smoke（Scheduler → Coordinator → Pipeline → SourceRun → Brief 闭环）', () => {
  it('startup catch-up 触发完整闭环，落 SourceRun + DailyBrief', async () => {
    seq += 1;
    const db: Database.Database = openDb(path.join(tempDir, `smoke-${seq}.sqlite3`));
    runMigrations(db, { targetVersion: DAILY_SEARCH_PLAN_CONTROL_SCHEMA_VERSION });
    const planRepo = new SearchPlanRepository(db);
    const sourceRunRepo = new SourceRunRepository(db);
    const briefRepo = new DailyBriefRepository(db);

    const base = Date.UTC(2026, 7, 14, 0, 0);
    planRepo.insertPlan({
      id: 'plan-1', name: '每日前端岗位', status: 'active', activeVersionId: null,
      createdAt: base, updatedAt: base, deletedAt: null,
    });
    planRepo.insertVersion({
      id: 'version-1', searchPlanId: 'plan-1', version: 1,
      cities: [{ name: '苏州', priority: 1 }], roleDirections: ['前端开发'], baseKeywords: ['React'],
      expandedKeywords: [], hardConstraints: [], sourceConfigs: [{ providerKey: 'tavily', enabled: true }],
      schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
      scanBudget: { maxQueriesPerRun: 5 }, analysisBudget: {}, briefPolicy: {},
      explorationPolicy: {}, notificationPolicy: {}, latestCatchUpTime: '12:00',
      createdAt: base, activatedAt: base, supersedesVersionId: null,
    });
    planRepo.setActiveVersion('plan-1', 'version-1');

    // controlled fake pipeline（外部 Tavily/LLM/网络边界 mock）。
    const emptyResult: DailyPipelineResult = {
      items: [], recommendationScope: [], recommendationBatchId: null,
      summary: {
        total: 0, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0,
        analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0,
        fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0,
        ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false,
      },
      coverage: { queriesCompleted: 1, queriesFailed: 0, failedScopes: [], queryResults: [] },
    };
    const pipelineRun = vi.fn(async () => emptyResult);
    const pipeline = { run: pipelineRun } as unknown as DailyPipeline;

    let idSeq = 0;
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
      getBatch: (id) => {
        const row = db.prepare(
          `SELECT selected_candidate_version_ids_json FROM radar_recommendation_batches WHERE id = ?`,
        ).get(id) as { selected_candidate_version_ids_json: string } | undefined;
        if (row === undefined) return null;
        return { selectedCandidateVersionIds: JSON.parse(row.selected_candidate_version_ids_json) as string[] };
      },
      createId: () => { idSeq += 1; return `run-${idSeq}`; },
      now: () => Date.UTC(2026, 7, 14, 2, 0),
    });

    const scheduler = new DailyJobScheduler({
      planRepo,
      coordinator,
      skipRepo: new SkipRepository(db),
      now: () => Date.UTC(2026, 7, 14, 2, 0), // 10:00 Shanghai → catch-up
      setTimeout: () => undefined,
      clearTimeout: () => undefined,
    });

    scheduler.start();
    await flush();
    scheduler.stop();

    // SourceRun 被创建且 SUCCEEDED。
    const runs = sourceRunRepo.listByPlanVersion('version-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerType).toBe('CATCH_UP');
    expect(runs[0]?.status).toBe('SUCCEEDED');
    expect(runs[0]?.scheduledDay).toBe('2026-08-14');

    // DailyBrief 被创建，costSummaryJson=null，sourceRunIds 引用该 run。
    const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
    expect(brief).not.toBeNull();
    expect(brief?.sourceRunIds).toEqual([runs[0]?.id]);
    expect(brief?.costSummaryJson).toBeNull();

    // pipeline 被调用（真实 wiring 生效），且只调用一次。
    expect(pipelineRun).toHaveBeenCalledTimes(1);

    db.close();
  });
});
