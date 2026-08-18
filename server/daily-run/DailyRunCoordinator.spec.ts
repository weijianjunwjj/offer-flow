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
import { emptyPipelineStageCounts, type DailyPipeline } from '../pipeline/DailyPipeline';
import type { SearchCoverage } from '../search-provider/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-coordinator-'));
let seq = 0;

/** 构造一个 SearchCoverage（query 级计数 + failedScopes）。 */
function coverage(
  queriesCompleted: number,
  queriesFailed = 0,
  failedScopes: SearchCoverage['failedScopes'] = [],
): SearchCoverage {
  return { queriesCompleted, queriesFailed, failedScopes, queryResults: [] };
}

/** 构造一个指定 coverage / items 的 Pipeline 结果（summary 与 items 数量对齐）。 */
function pipelineResultWithCoverage(
  cov: SearchCoverage,
  items: DailyPipelineResult['items'] = [],
): DailyPipelineResult {
  return {
    items,
    recommendationScope: [],
    recommendationBatchId: null,
    summary: {
      total: items.length, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0,
      analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0,
      fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0,
      ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false,
    },
    coverage: cov,
    stageCounts: emptyPipelineStageCounts(),
  };
}

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
      coverage: coverage(1),
      stageCounts: emptyPipelineStageCounts(),
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
      getBatch: (id) => {
        const row = db.prepare(
          `SELECT selected_candidate_version_ids_json FROM radar_recommendation_batches WHERE id = ?`,
        ).get(id) as { selected_candidate_version_ids_json: string } | undefined;
        if (row === undefined) return null;
        return { selectedCandidateVersionIds: JSON.parse(row.selected_candidate_version_ids_json) as string[] };
      },
      createId: () => { idSeq += 1; return `run-${idSeq}`; },
      now: () => now,
    });

    await run({ coordinator, db, planRepo, sourceRunRepo, briefRepo, pipelineRun, versionId: 'version-1', planId: 'plan-1' });
    db.close();
  })();
}

/** 插入一个指定 selected 内容的批次行（selected 非空 = 非空推荐批次，空 = 空批次）。 */
function insertBatch(db: Database.Database, id: string, selected: string[]): void {
  db.prepare(`
    INSERT INTO radar_recommendation_batches (
      id, batch_key, status, scope_json, candidate_version_ids_json,
      selected_candidate_version_ids_json, profile_versions_json, rule_version,
      recommendation_rule_version, analysis_policy_version, handled_state_hash,
      diagnosis_status, generated_at, created_at
    ) VALUES (?, ?, 'succeeded', '{}', ?, ?, '{}',
      'radar-recommendation:v1', 'radar-recommendation:v1', 'analysis-policy:v1',
      'hash', 'insufficient_evidence', 1, 1)
  `).run(id, `key-${id}`, JSON.stringify(selected), JSON.stringify(selected));
}

/** 构造一个推荐非空（或指定 batch id）的 Pipeline 结果。 */
function pipelineResultWithBatch(batchId: string, scope: string[]): DailyPipelineResult {
  return {
    items: [],
    recommendationScope: scope,
    recommendationBatchId: batchId,
    summary: {
      total: 0, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0,
      analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0,
      fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0,
      ingestFailed: 0, aborted: 0, recommendationBatchId: batchId, recommendationBatchCreated: true,
    },
    coverage: coverage(1),
    stageCounts: emptyPipelineStageCounts(),
  };
}

/** 构造一个含 discovery 条目（manualReview 结果）的 Pipeline 结果；sourceVersionId 即 discovery item ids。 */
function pipelineResultWithDiscovery(versionIds: string[]): DailyPipelineResult {
  return {
    items: versionIds.map((id) => ({
      index: 0,
      itemUrl: `https://example.com/${id}`,
      candidateId: `cand-${id}`,
      sourceVersionId: id,
      finalVersionId: id,
      finalOutcome: 'manualReview' as const,
      reasonCode: null,
      milestones: {
        ingested: true, fetchAttempted: false, upgraded: false, alreadyUpgraded: false,
        analysisTaskCreated: false, analysisCompleted: false, inRecommendationScope: false,
      },
      summary: 'manual review',
    })),
    recommendationScope: [],
    recommendationBatchId: null,
    summary: {
      total: versionIds.length, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0,
      analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: versionIds.length, discoveryOnly: 0,
      fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0,
      ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false,
    },
    coverage: coverage(versionIds.length),
    stageCounts: emptyPipelineStageCounts(),
  };
}

describe('DailyRunCoordinator（T028 闭环核心）', () => {
  it('Pipeline 前创建 SourceRun；Pipeline success → SourceRun SUCCEEDED', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      const order: string[] = [];
      pipelineRun.mockImplementationOnce(async () => {
        order.push('pipeline');
        return { items: [], recommendationScope: [], recommendationBatchId: null, summary: { total: 0, analysisCompleted: 0, analysisFailed: 0, analysisBlocked: 0, analysisAlreadyRunning: 0, analysisCancelled: 0, manualReview: 0, discoveryOnly: 0, fetchFailed: 0, validationFailed: 0, upgradeBlocked: 0, upgradeFailed: 0, ingestFailed: 0, aborted: 0, recommendationBatchId: null, recommendationBatchCreated: false }, coverage: coverage(1), stageCounts: emptyPipelineStageCounts() };
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

  it('Pipeline 空推荐 scope → Brief 引用 createEmptyBatch 的空批次（OPTION A，非 null）', async () => {
    await withCoordinator(async ({ coordinator, briefRepo }) => {
      // 默认 pipeline 返回 emptyResult（recommendationScope=[]、recommendationBatchId=null）。
      const result = await coordinator.run({
        searchPlanVersionId: 'version-1', triggerType: 'SCHEDULED',
        scheduledFor: Date.UTC(2026, 7, 14, 1, 0), scheduledDay: '2026-08-14',
      });
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
        assert.ok(brief !== null);
        // OPTION A：空 scope 也落一个正式空批次引用，绝不落 null（满足 NOT NULL + FK 领域语义）。
        assert.ok(brief.recommendationBatchId.startsWith('batch-empty-'));
      }
    });
  });
});

describe('DailyRunCoordinator — DailyBrief recommendation reconciliation（MONOTONIC USEFULNESS）', () => {
  const manualInput = () => ({
    searchPlanVersionId: 'version-1',
    triggerType: 'MANUAL' as const,
    scheduledFor: Date.UTC(2026, 7, 14, 2, 0),
    scheduledDay: null,
  });

  it('first run EMPTY → brief empty，emptyReason 填充', async () => {
    await withCoordinator(async ({ coordinator, briefRepo }) => {
      await coordinator.run(manualInput());
      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.ok(brief.recommendationBatchId.startsWith('batch-empty-'));
      assert.equal(brief.emptyReason, '今日未发现值得处理的新岗位');
    });
  });

  it('EMPTY → EMPTY → 同一 logical brief（row=1）保持 empty，sourceRunIds 去重 merge', async () => {
    await withCoordinator(async ({ coordinator, briefRepo }) => {
      const first = await coordinator.run(manualInput());
      const second = await coordinator.run(manualInput());
      assert.equal(first.outcome, 'completed');
      assert.equal(second.outcome, 'completed');
      if (first.outcome === 'completed' && second.outcome === 'completed') {
        const briefs = briefRepo.listRecent(10).filter((b) => b.searchPlanVersionId === 'version-1');
        assert.equal(briefs.length, 1);
        const brief = briefs[0]!;
        assert.ok(brief.recommendationBatchId.startsWith('batch-empty-'));
        assert.equal(brief.emptyReason, '今日未发现值得处理的新岗位');
        // sourceRunIds 稳定去重 merge：两个不同 SourceRun 各自只出现一次。
        assert.deepEqual(brief.sourceRunIds, [first.sourceRunId, second.sourceRunId]);
      }
    });
  });

  it('EMPTY → NON_EMPTY → brief 升级引用非空批次', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db, pipelineRun }) => {
      // run-1：默认 empty。
      await coordinator.run(manualInput());
      // run-2：产生非空批次。
      insertBatch(db, 'batch-nonempty-1', ['v1']);
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithBatch('batch-nonempty-1', ['v1']));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-nonempty-1');
      assert.equal(brief.emptyReason, null);
    });
  });

  it('NON_EMPTY → EMPTY → brief 保留既有非空批次（禁止降级为空），emptyReason 仍 null', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db, pipelineRun }) => {
      insertBatch(db, 'batch-nonempty-1', ['v1']);
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithBatch('batch-nonempty-1', ['v1']));
      // run-1：非空。
      await coordinator.run(manualInput());
      // run-2：默认 empty（recommendationBatchId=null → createEmptyBatch）。
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-nonempty-1');
      assert.equal(brief.emptyReason, null);
    });
  });

  it('NON_EMPTY A → NON_EMPTY B → brief 引用最新 B', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db, pipelineRun }) => {
      insertBatch(db, 'batch-a', ['v1']);
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithBatch('batch-a', ['v1']));
      await coordinator.run(manualInput());

      insertBatch(db, 'batch-b', ['v2']);
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithBatch('batch-b', ['v2']));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-b');
      assert.equal(brief.emptyReason, null);
    });
  });

  it('same SCHEDULED occurrence 重复 run → skip（无 provenance 重复）', async () => {
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

describe('DailyRunCoordinator — DailyBrief discovery reconciliation（day-level monotonic union）', () => {
  const manualInput = () => ({
    searchPlanVersionId: 'version-1',
    triggerType: 'MANUAL' as const,
    scheduledFor: Date.UTC(2026, 7, 14, 2, 0),
    scheduledDay: null,
  });

  it('discovery [a] → incoming [] → 保留 [a]（禁止清空）', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      await coordinator.run(manualInput());
      await coordinator.run(manualInput()); // 第二次默认 emptyResult（无 discovery）

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['d-a']);
    });
  });

  it('discovery [a] → [b] → 合并为 [a,b]', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      await coordinator.run(manualInput());
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-b']));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['d-a', 'd-b']);
    });
  });

  it('discovery [a,b] → [b,c] → 合并为 [a,b,c]（既有顺序优先 + 去重）', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a', 'd-b']));
      await coordinator.run(manualInput());
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-b', 'd-c']));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['d-a', 'd-b', 'd-c']);
    });
  });

  it('同一 discovery 重复 run → 不产生重复 ids', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      await coordinator.run(manualInput());
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['d-a']);
    });
  });

  it('recommendation 非空 + 后续空 discovery → recommendation 不受影响，discovery 保留', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db, pipelineRun }) => {
      insertBatch(db, 'batch-nonempty-1', ['v1']);
      pipelineRun.mockImplementationOnce(async () => ({
        ...pipelineResultWithBatch('batch-nonempty-1', ['v1']),
        items: pipelineResultWithDiscovery(['d-a']).items,
      }));
      await coordinator.run(manualInput());
      // 后续空结果（无推荐 scope、无 discovery）。
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-nonempty-1');
      assert.deepEqual(brief.discoveryItemIds, ['d-a']);
      assert.equal(brief.emptyReason, null);
    });
  });

  it('既有 discovery + 后续空 run → emptyReason 不误判为「今日无发现」', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      await coordinator.run(manualInput());
      await coordinator.run(manualInput()); // 空结果

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['d-a']);
      assert.equal(brief.emptyReason, null);
    });
  });

  it('多 run 合并后 logical brief row 仍为 1，sourceRunIds 去重 merge 正确', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-a']));
      const first = await coordinator.run(manualInput());
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithDiscovery(['d-b']));
      const second = await coordinator.run(manualInput());

      assert.equal(first.outcome, 'completed');
      assert.equal(second.outcome, 'completed');
      if (first.outcome === 'completed' && second.outcome === 'completed') {
        const briefs = briefRepo.listRecent(10).filter((b) => b.searchPlanVersionId === 'version-1');
        assert.equal(briefs.length, 1);
        assert.deepEqual(briefs[0]?.sourceRunIds, [first.sourceRunId, second.sourceRunId]);
        assert.deepEqual(briefs[0]?.discoveryItemIds, ['d-a', 'd-b']);
      }
    });
  });
});

describe('DailyRunCoordinator — coverage / terminal status（FR-015 / SC-012 来源失败不伪装业务空结果）', () => {
  const manualInput = () => ({
    searchPlanVersionId: 'version-1',
    triggerType: 'MANUAL' as const,
    scheduledFor: Date.UTC(2026, 7, 14, 2, 0),
    scheduledDay: null,
  });

  it('1 query success + 0 results → succeeded=1 failed=0，SUCCEEDED（合法空，非失败）', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(coverage(1)));
      const result = await coordinator.run(manualInput());
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        assert.equal(result.status, 'SUCCEEDED');
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.equal(run?.queriesAttempted, 1);
        assert.equal(run?.queriesSucceeded, 1);
        assert.equal(run?.queriesFailed, 0);
        assert.equal(run?.coverage.queriesCompleted, 1);
        assert.equal(run?.coverage.queriesFailed, 0);
        assert.equal(run?.queriesAttempted, (run?.queriesSucceeded ?? 0) + (run?.queriesFailed ?? 0));
      }
    });
  });

  it('1 query success + N results → coverage 持久化到 SourceRun', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      const item = {
        index: 0, itemUrl: 'https://example.com/a', candidateId: 'cand-a',
        sourceVersionId: 'v-a', finalVersionId: 'v-a',
        finalOutcome: 'manualReview' as const, reasonCode: null,
        milestones: {
          ingested: true, fetchAttempted: false, upgraded: false, alreadyUpgraded: false,
          analysisTaskCreated: false, analysisCompleted: false, inRecommendationScope: false,
        },
        summary: 'manual review',
      };
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(coverage(1), [item]));
      const result = await coordinator.run(manualInput());
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.equal(run?.status, 'SUCCEEDED');
        assert.equal(run?.coverage.queriesCompleted, 1);
        assert.equal(run?.coverage.queriesFailed, 0);
      }
    });
  });

  it('all queries provider failure → FAILED（绝不 SUCCEEDED），且不生成业务空 Brief', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(
        coverage(0, 1, [{ queryKey: '苏州×前端开发×React', errorCode: 'AUTH_ERROR', message: 'Tavily API Key 无效' }]),
      ));
      const result = await coordinator.run(manualInput());
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        assert.equal(result.status, 'FAILED');
        assert.equal(result.briefId, null);
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.equal(run?.status, 'FAILED');
        assert.equal(run?.errorCode, 'ALL_QUERIES_FAILED');
        assert.equal(run?.queriesAttempted, 1);
        assert.equal(run?.queriesSucceeded, 0);
        assert.equal(run?.queriesFailed, 1);
        assert.equal(run?.queriesAttempted, (run?.queriesSucceeded ?? 0) + (run?.queriesFailed ?? 0));
      }
      // 不得产生「今日未发现值得处理的新岗位」业务空 Brief。
      expect(briefRepo.findByLogicalIdentity('2026-08-14', 'version-1')).toBeNull();
    });
  });

  it('all queries failure → coverage 只落 queryKey+errorCode+message，不落 raw body/secret', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(
        coverage(0, 1, [{ queryKey: '苏州×前端开发×React', errorCode: 'AUTH_ERROR', message: 'Tavily API Key 无效' }]),
      ));
      const result = await coordinator.run(manualInput());
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.ok(run !== null);
        assert.equal(run.status, 'FAILED');
        assert.equal(run.coverage.failedScopes.length, 1);
        assert.deepEqual(run.coverage.failedScopes[0], {
          queryKey: '苏州×前端开发×React', errorCode: 'AUTH_ERROR', message: 'Tavily API Key 无效',
        });
        // 只透出 queryKey + errorCode，绝不落 provider raw body / secret。
        expect(JSON.stringify(run.coverage)).not.toContain('tvly-');
        expect(JSON.stringify(run.coverage)).not.toContain('raw');
        expect(run.errorMessage).toContain('AUTH_ERROR');
      }
    });
  });

  it('partial success/failure → PARTIALLY_SUCCEEDED，attempted = succeeded + failed', async () => {
    await withCoordinator(async ({ coordinator, sourceRunRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(
        coverage(1, 1, [{ queryKey: '上海×前端开发×React', errorCode: 'TIMEOUT', message: 'timeout' }]),
      ));
      const result = await coordinator.run(manualInput());
      assert.equal(result.outcome, 'completed');
      if (result.outcome === 'completed') {
        assert.equal(result.status, 'PARTIALLY_SUCCEEDED');
        const run = sourceRunRepo.getById(result.sourceRunId);
        assert.equal(run?.queriesAttempted, 2);
        assert.equal(run?.queriesSucceeded, 1);
        assert.equal(run?.queriesFailed, 1);
        assert.equal(run?.queriesAttempted, (run?.queriesSucceeded ?? 0) + (run?.queriesFailed ?? 0));
      }
    });
  });

  it('all-failure 不阻断后续 successful rerun 创建/升级 Brief（reconciliation）', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, db, pipelineRun }) => {
      // run-1：全部失败 → 无 brief。
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(
        coverage(0, 1, [{ queryKey: '苏州×前端开发×React', errorCode: 'AUTH_ERROR', message: 'x' }]),
      ));
      const first = await coordinator.run(manualInput());
      assert.equal(first.outcome, 'completed');
      if (first.outcome === 'completed') assert.equal(first.status, 'FAILED');

      // run-2：成功且产生非空批次。
      insertBatch(db, 'batch-nonempty-1', ['v1']);
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithBatch('batch-nonempty-1', ['v1']));
      const second = await coordinator.run(manualInput());
      assert.equal(second.outcome, 'completed');
      if (second.outcome === 'completed') assert.equal(second.status, 'SUCCEEDED');

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-nonempty-1');
      assert.equal(brief.emptyReason, null);
    });
  });

  it('brief 持久化真实 coverage（修复「今日搜索覆盖显示 0」），多 run 累积合并', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(coverage(30, 0)));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      // 真实 30/30 覆盖被持久化到 brief，而非 EMPTY_COVERAGE 的 0。
      assert.equal(brief.coverage.queriesCompleted, 30);
      assert.equal(brief.coverage.queriesFailed, 0);

      // 第二次 run：coverage(2, 1) → 累积合并为 32 completed / 1 failed。
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(
        coverage(2, 1, [{ queryKey: '苏州×前端开发×React', errorCode: 'TIMEOUT', message: 'timeout' }]),
      ));
      await coordinator.run(manualInput());

      const merged = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(merged !== null);
      assert.equal(merged.coverage.queriesCompleted, 32);
      assert.equal(merged.coverage.queriesFailed, 1);
      assert.equal(merged.coverage.failedScopes.length, 1);
      assert.equal(merged.coverage.failedScopes[0]?.queryKey, '苏州×前端开发×React');
    });
  });

  it('coverage merge 语义冻结（GATE 1）：counters 累计（A），queryResults/failedScopes 按 queryKey 去重', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      // run-1：30 完成，queryKey 'q1'
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage({
        queriesCompleted: 30, queriesFailed: 0, failedScopes: [],
        queryResults: [{ queryKey: 'q1', status: 'COMPLETED', resultsReturned: 5 }],
      }));
      await coordinator.run(manualInput());
      // run-2：30 完成，同一 queryKey 'q1'（重复执行）
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage({
        queriesCompleted: 30, queriesFailed: 0, failedScopes: [],
        queryResults: [{ queryKey: 'q1', status: 'COMPLETED', resultsReturned: 5 }],
      }));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      // A：counters 累计，30 + 30 = 60 是 intentional。
      assert.equal(brief.coverage.queriesCompleted, 60);
      assert.equal(brief.coverage.queriesFailed, 0);
      // 列表按 queryKey 去重：同一查询只保留一条逻辑覆盖记录。
      assert.equal(brief.coverage.queryResults.length, 1);
      assert.equal(brief.coverage.queryResults[0]?.queryKey, 'q1');
    });
  });
});

describe('DailyRunCoordinator — Discovery Preservation Across Enrichment Failure（Bug B）', () => {
  const manualInput = () => ({
    searchPlanVersionId: 'version-1',
    triggerType: 'MANUAL' as const,
    scheduledFor: Date.UTC(2026, 7, 14, 2, 0),
    scheduledDay: null,
  });

  function enrichmentItem(
    finalOutcome: DailyPipelineResult['items'][number]['finalOutcome'],
    versionId: string,
  ): DailyPipelineResult['items'][number] {
    return {
      index: 0,
      itemUrl: `https://example.com/${versionId}`,
      candidateId: `cand-${versionId}`,
      sourceVersionId: versionId,
      finalVersionId: null,
      finalOutcome,
      reasonCode: 'x',
      milestones: {
        ingested: true, fetchAttempted: true, upgraded: false, alreadyUpgraded: false,
        analysisTaskCreated: false, analysisCompleted: false, inRecommendationScope: false,
      },
      summary: finalOutcome,
    };
  }

  it.each(['fetchFailed', 'validationFailed', 'upgradeBlocked', 'upgradeFailed'] as const)(
    '%s → 仍进入 discoveryItemIds（initial ingestion PASS 后 enrichment 失败不丢发现）',
    async (finalOutcome) => {
      await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
        pipelineRun.mockImplementationOnce(async () =>
          pipelineResultWithCoverage(coverage(1), [enrichmentItem(finalOutcome, 'v-1')]));
        await coordinator.run(manualInput());

        const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
        assert.ok(brief !== null);
        assert.deepEqual(brief.discoveryItemIds, ['v-1']);
      });
    },
  );

  it('initial ingestion FAIL（ingestFailed, sourceVersionId=null）→ 不产生 fake discoveryItemId', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      const item: DailyPipelineResult['items'][number] = {
        index: 0, itemUrl: 'https://example.com/x', candidateId: null,
        sourceVersionId: null, finalVersionId: null, finalOutcome: 'ingestFailed', reasonCode: 'boom',
        milestones: {
          ingested: false, fetchAttempted: false, upgraded: false, alreadyUpgraded: false,
          analysisTaskCreated: false, analysisCompleted: false, inRecommendationScope: false,
        },
        summary: 'ingestFailed',
      };
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(coverage(1), [item]));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, []);
    });
  });

  it('同 CandidateVersion 多个 query 命中 → Brief 仍只出现一次（stable union dedupe）', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      const items: DailyPipelineResult['items'] = ['v-1', 'v-1'].map((id, i) => ({
        index: i, itemUrl: `https://example.com/${i}`, candidateId: `cand-${id}`,
        sourceVersionId: id, finalVersionId: null, finalOutcome: 'fetchFailed', reasonCode: 'FETCH_FAILED',
        milestones: {
          ingested: true, fetchAttempted: true, upgraded: false, alreadyUpgraded: false,
          analysisTaskCreated: false, analysisCompleted: false, inRecommendationScope: false,
        },
        summary: 'fetchFailed',
      }));
      pipelineRun.mockImplementationOnce(async () => pipelineResultWithCoverage(coverage(2), items));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['v-1']);
    });
  });

  it('历史 empty Brief → 后续 fetchFailed discovery → monotonic upgrade 正常', async () => {
    await withCoordinator(async ({ coordinator, briefRepo, pipelineRun }) => {
      // run-1：空（无 discovery）。
      await coordinator.run(manualInput());
      // run-2：fetchFailed 仍产生 discovery。
      pipelineRun.mockImplementationOnce(async () =>
        pipelineResultWithCoverage(coverage(1), [enrichmentItem('fetchFailed', 'v-1')]));
      await coordinator.run(manualInput());

      const brief = briefRepo.findByLogicalIdentity('2026-08-14', 'version-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['v-1']);
      assert.equal(brief.emptyReason, null);
    });
  });
});
