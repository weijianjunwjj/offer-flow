import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_JOB_BRIEF_SCHEMA_VERSION, runMigrations } from '../migrations';
import { DailyBriefRepository } from './dailyBriefRepository';
import type { DailyJobBrief } from './types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-daily-brief-'));
let databaseSequence = 0;

function withRepo(run: (repo: DailyBriefRepository, db: Database.Database) => void): void {
  databaseSequence += 1;
  const dbPath = path.join(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    runMigrations(db, { targetVersion: DAILY_JOB_BRIEF_SCHEMA_VERSION });
    setupPlanVersion(db);
    run(new DailyBriefRepository(db), db);
  } finally {
    db.close();
  }
}

function setupPlanVersion(db: Database.Database): void {
  db.prepare(`
    INSERT INTO daily_search_plans (id, name, status, active_version_id, created_at, updated_at, deleted_at)
    VALUES ('plan-1', '每日前端岗位', 'active', null, 100, 100, null)
  `).run();
  db.prepare(`
    INSERT INTO daily_search_plan_versions (
      id, search_plan_id, version, cities_json, role_directions_json, base_keywords_json,
      expanded_keywords_json, hard_constraints_json, source_configs_json, schedule_json,
      scan_budget_json, analysis_budget_json, brief_policy_json, exploration_policy_json,
      notification_policy_json, latest_catch_up_time, created_at, activated_at, supersedes_version_id
    ) VALUES (
      'version-1', 'plan-1', 1, '[]', '[]', '[]', '[]', '[]',
      '[{"providerKey":"tavily"}]', '{}', '{}', '{}', '{}', '{}', '{}', '09:00', 100, null, null
    )
  `).run();
}

/** 造一个最小合法 radar_recommendation_batches 行（daily_job_briefs 的 FK 目标）。 */
function setupRecommendationBatch(db: Database.Database, id: string, candidateVersionIds: string[]): void {
  db.prepare(`
    INSERT INTO radar_recommendation_batches (
      id, batch_key, status, scope_json, candidate_version_ids_json,
      selected_candidate_version_ids_json, profile_versions_json, rule_version,
      recommendation_rule_version, analysis_policy_version, handled_state_hash,
      diagnosis_status, generated_at, created_at
    ) VALUES (
      ?, ?, 'succeeded', '{}', ?, ?, '{}', 'radar-recommendation:v1',
      'radar-recommendation:v1', 'analysis-policy:v1', 'hash-1',
      'insufficient_evidence', 100, 100
    )
  `).run(id, `batch-key-${id}`, JSON.stringify(candidateVersionIds), JSON.stringify(candidateVersionIds));
}

function makeBrief(overrides: Partial<DailyJobBrief> = {}): DailyJobBrief {
  return {
    id: 'brief-1',
    briefDate: '2026-08-13',
    searchPlanVersionId: 'version-1',
    sourceRunIds: ['run-1'],
    recommendationBatchId: 'batch-1',
    discoveryItemIds: [],
    status: 'READY',
    coverage: { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] },
    costSummaryJson: null,
    emptyReason: null,
    generatedAt: 100,
    completedAt: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('DailyBriefRepository（T040）', () => {
  it('recommendation items 正确进入 brief（recommendationBatchId 引用既有批次）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', ['rcv-1', 'rcv-2']);
      repo.insert(makeBrief({ recommendationBatchId: 'batch-1' }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.equal(brief.recommendationBatchId, 'batch-1');
      // 正式推荐条目由 batch 承载，brief 只引用 batch，不复制 items。
      const batch = db.prepare('SELECT candidate_version_ids_json FROM radar_recommendation_batches WHERE id = ?').get('batch-1') as { candidate_version_ids_json: string };
      assert.deepEqual(JSON.parse(batch.candidate_version_ids_json), ['rcv-1', 'rcv-2']);
    });
  });

  it('discovery / manual-review items 正确进入 brief（discoveryItemIds）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ discoveryItemIds: ['rcv-se-1', 'rcv-mrr-2'] }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['rcv-se-1', 'rcv-mrr-2']);
    });
  });

  it('searchPlanVersionId 与 sourceRunIds 正确（provenance 主链）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ searchPlanVersionId: 'version-1', sourceRunIds: ['run-a', 'run-b'] }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.equal(brief.searchPlanVersionId, 'version-1');
      assert.deepEqual(brief.sourceRunIds, ['run-a', 'run-b']);
    });
  });

  it('coverage 正确持久化（复用 SearchCoverage，JSON 往返）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      const coverage = {
        queriesCompleted: 22,
        queriesFailed: 2,
        failedScopes: [{ queryKey: '苏州×AI前端', errorCode: 'VALID_EMPTY' as const, message: 'empty' }],
        queryResults: [{ queryKey: '苏州×前端开发', status: 'COMPLETED' as const, resultsReturned: 12 }],
      };
      repo.insert(makeBrief({ coverage }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.coverage, coverage);
    });
  });

  it('costSummaryJson = null 时合法（null = cost summary 尚未计算）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ costSummaryJson: null }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.equal(brief.costSummaryJson, null);
    });
  });

  it('recommendation empty + discovery 非空合法', () => {
    withRepo((repo, db) => {
      // batch 0 条选中 + discovery 有发现条目。
      setupRecommendationBatch(db, 'batch-empty', []);
      repo.insert(makeBrief({
        recommendationBatchId: 'batch-empty',
        discoveryItemIds: ['rcv-se-1'],
        emptyReason: null,
      }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['rcv-se-1']);
      assert.equal(brief.emptyReason, null);
    });
  });

  it('discovery empty + recommendation 非空合法', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', ['rcv-1']);
      repo.insert(makeBrief({ discoveryItemIds: [], recommendationBatchId: 'batch-1' }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, []);
      assert.equal(brief.recommendationBatchId, 'batch-1');
    });
  });

  it('完全空 run：0 推荐 + 0 发现 + emptyReason 填充', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-empty', []);
      repo.insert(makeBrief({
        recommendationBatchId: 'batch-empty',
        discoveryItemIds: [],
        emptyReason: '今日未发现值得处理的新岗位',
      }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, []);
      assert.equal(brief.recommendationBatchId, 'batch-empty');
      assert.equal(brief.emptyReason, '今日未发现值得处理的新岗位');
    });
  });

  it('repeat build 幂等：相同 id 重复 insert 由主键拒绝，findByDate 可去重', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ id: 'brief-1' }));
      assert.throws(() => {
        repo.insert(makeBrief({ id: 'brief-1' }));
      }, /UNIQUE constraint failed|PRIMARY KEY/);
      const briefs = repo.findByDate('2026-08-13');
      assert.equal(briefs.length, 1);
      assert.equal(briefs[0].id, 'brief-1');
    });
  });

  it('纯下游 projection：不创建新 RecommendationBatch / 不运行 Analysis / 不运行 Evidence Upgrade / 不 Fetch / 不 Search', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', ['rcv-1']);
      const batchCountBefore = (db.prepare('SELECT COUNT(*) AS c FROM radar_recommendation_batches').get() as { c: number }).c;

      repo.insert(makeBrief({ discoveryItemIds: ['rcv-se-1'] }));

      // 不创建新 batch
      const batchCountAfter = (db.prepare('SELECT COUNT(*) AS c FROM radar_recommendation_batches').get() as { c: number }).c;
      assert.equal(batchCountAfter, batchCountBefore);

      // 不创建 analysis_tasks / radar_candidate_versions / radar_capture_snapshots
      const analysisCount = (db.prepare('SELECT COUNT(*) AS c FROM analysis_tasks').get() as { c: number }).c;
      assert.equal(analysisCount, 0);
      const versionCount = (db.prepare('SELECT COUNT(*) AS c FROM radar_candidate_versions').get() as { c: number }).c;
      assert.equal(versionCount, 0);
      const snapshotCount = (db.prepare('SELECT COUNT(*) AS c FROM radar_capture_snapshots').get() as { c: number }).c;
      assert.equal(snapshotCount, 0);
    });
  });

  it('candidate/version provenance 可追溯（discoveryItemIds + batch 候选版本 ID 保留）', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', ['rcv-full-1', 'rcv-full-2']);
      repo.insert(makeBrief({ recommendationBatchId: 'batch-1', discoveryItemIds: ['rcv-se-1', 'rcv-mrr-2'] }));
      const brief = repo.getById('brief-1');
      assert.ok(brief !== null);
      assert.deepEqual(brief.discoveryItemIds, ['rcv-se-1', 'rcv-mrr-2']);
      const batch = db.prepare('SELECT candidate_version_ids_json FROM radar_recommendation_batches WHERE id = ?').get('batch-1') as { candidate_version_ids_json: string };
      assert.deepEqual(JSON.parse(batch.candidate_version_ids_json), ['rcv-full-1', 'rcv-full-2']);
    });
  });

  it('status transition：GENERATING → READY → IN_REVIEW → COMPLETED', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ status: 'GENERATING' }));
      repo.updateStatus('brief-1', 'READY');
      repo.updateStatus('brief-1', 'IN_REVIEW');
      repo.updateStatus('brief-1', 'COMPLETED');
      const brief = repo.getById('brief-1');
      assert.equal(brief?.status, 'COMPLETED');
      assert.ok(brief?.completedAt !== null, '进入终态应记录 completedAt');
    });
  });

  it('status transition 非法：终态不可再转移', () => {
    withRepo((repo, db) => {
      setupRecommendationBatch(db, 'batch-1', []);
      repo.insert(makeBrief({ status: 'COMPLETED' }));
      assert.throws(() => {
        repo.updateStatus('brief-1', 'READY');
      }, /illegal daily job brief status transition/);
    });
  });
});
