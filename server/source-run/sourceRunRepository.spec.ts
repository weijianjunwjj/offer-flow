import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { SOURCE_RUN_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SourceRunRepository } from './sourceRunRepository';
import type { SourceRun } from './types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-source-run-'));
let databaseSequence = 0;

function withRepo(run: (repo: SourceRunRepository, db: Database.Database) => void): void {
  databaseSequence += 1;
  const dbPath = path.join(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    runMigrations(db, { targetVersion: SOURCE_RUN_SCHEMA_VERSION });
    setupPlanVersion(db);
    run(new SourceRunRepository(db), db);
  } finally {
    db.close();
  }
}

/** source_runs 外键指向 daily_search_plan_versions，先造最小 provenance 主链。 */
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
      '[{"providerKey":"tavily","searchDepth":"basic","country":"china","enabled":true}]',
      '{}', '{}', '{}', '{}', '{}', '{}', '09:00', 100, null, null
    )
  `).run();
}

function makeRun(overrides: Partial<SourceRun> = {}): SourceRun {
  return {
    id: 'run-1',
    searchPlanVersionId: 'version-1',
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

describe('SourceRunRepository（T029）', () => {
  it('创建 run：insert + getById 往返保留字段', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      const run = repo.getById('run-1');
      assert.ok(run !== null);
      assert.equal(run.id, 'run-1');
      assert.equal(run.searchPlanVersionId, 'version-1');
      assert.equal(run.sourceKey, 'tavily');
      assert.equal(run.sourceVersion, '1.0.0');
      assert.equal(run.triggerType, 'SCHEDULED');
      assert.equal(run.status, 'PENDING');
      assert.equal(run.phase, 'PREPARING');
    });
  });

  it('planVersion 关联正确：search_plan_version_id 外键指向不存在的版本被拒绝', () => {
    withRepo((repo, db) => {
      assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
      assert.throws(() => {
        repo.insert(makeRun({ id: 'run-bad', searchPlanVersionId: 'missing-version' }));
      }, /FOREIGN KEY constraint failed/);
    });
  });

  it('coverage 与 provider metadata 可追溯（JSON 往返）', () => {
    withRepo((repo) => {
      const coverage = {
        queriesCompleted: 22,
        queriesFailed: 2,
        failedScopes: [{ queryKey: '苏州×AI前端', errorCode: 'VALID_EMPTY' as const, message: 'empty' }],
        queryResults: [{ queryKey: '苏州×前端开发', status: 'COMPLETED' as const, resultsReturned: 12 }],
      };
      repo.insert(makeRun({
        sourceKey: 'tavily',
        sourceVersion: '1.0.0',
        coverage,
        estimatedSearchCredits: 24,
        actualSearchCredits: 22,
      }));
      const run = repo.getById('run-1');
      assert.ok(run !== null);
      assert.deepEqual(run.coverage, coverage);
      assert.equal(run.estimatedSearchCredits, 24);
      assert.equal(run.actualSearchCredits, 22);
    });
  });

  it('status transition 合法：PENDING → RUNNING → SUCCEEDED', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      repo.transitionStatus('run-1', { toStatus: 'RUNNING' });
      let run = repo.getById('run-1');
      assert.equal(run?.status, 'RUNNING');
      assert.ok(run?.startedAt !== null, '进入 RUNNING 应记录 startedAt');

      repo.transitionStatus('run-1', { toStatus: 'SUCCEEDED' });
      run = repo.getById('run-1');
      assert.equal(run?.status, 'SUCCEEDED');
      assert.ok(run?.finishedAt !== null, '进入终态应记录 finishedAt');
    });
  });

  it('status transition 非法：终态不可再转移', () => {
    withRepo((repo) => {
      repo.insert(makeRun({ status: 'SUCCEEDED', startedAt: 100, finishedAt: 200 }));
      assert.throws(() => {
        repo.transitionStatus('run-1', { toStatus: 'FAILED' });
      }, /illegal source run status transition/);
    });
  });

  it('status transition 非法：PENDING 不能直接跳到 SUCCEEDED（必须先 RUNNING）', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      assert.throws(() => {
        repo.transitionStatus('run-1', { toStatus: 'SUCCEEDED' });
      }, /illegal source run status transition/);
    });
  });

  it('幂等：重复转移到相同状态为 no-op，不抛错', () => {
    withRepo((repo) => {
      repo.insert(makeRun({ status: 'SUCCEEDED', startedAt: 100, finishedAt: 200 }));
      // 相同终态重复转移应幂等返回，不抛错。
      repo.transitionStatus('run-1', { toStatus: 'SUCCEEDED' });
      const run = repo.getById('run-1');
      assert.equal(run?.status, 'SUCCEEDED');
    });
  });

  it('重试链：retry_of_run_id 自引用被 CHECK 拒绝', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      assert.throws(() => {
        repo.insert(makeRun({ id: 'run-2', retryOfRunId: 'run-2' }));
      }, /CHECK constraint failed/);
    });
  });

  it('重试链：retry_of_run_id 关联前一次 run 可追溯', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      repo.insert(makeRun({ id: 'run-2', triggerType: 'RETRY', retryOfRunId: 'run-1' }));
      const retry = repo.getById('run-2');
      assert.ok(retry !== null);
      assert.equal(retry.retryOfRunId, 'run-1');
      assert.equal(retry.triggerType, 'RETRY');
    });
  });

  it('listByPlanVersion 按创建时间降序返回', () => {
    withRepo((repo) => {
      repo.insert(makeRun({ id: 'run-a', createdAt: 100, updatedAt: 100 }));
      repo.insert(makeRun({ id: 'run-b', createdAt: 200, updatedAt: 200 }));
      const runs = repo.listByPlanVersion('version-1');
      assert.deepEqual(runs.map((r) => r.id), ['run-b', 'run-a']);
    });
  });

  it('纯持久化：insert 不触发 DailyPipeline / DailyBrief / Scheduler（无额外副作用）', () => {
    withRepo((repo, db) => {
      repo.insert(makeRun());
      // 只写入 source_runs 一行。
      const runCount = (db.prepare('SELECT COUNT(*) AS c FROM source_runs').get() as { c: number }).c;
      assert.equal(runCount, 1);
      // daily_job_briefs 表在 v11 尚未创建（T040 属于后续 task），本 Repository 不触碰它。
      const tables = (db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>).map((row) => row.name);
      assert.ok(!tables.includes('daily_job_briefs'), '不应出现 daily_job_briefs 表');
    });
  });

  it('updateProgress 更新阶段/计数/coverage', () => {
    withRepo((repo) => {
      repo.insert(makeRun());
      repo.updateProgress('run-1', {
        phase: 'DISCOVERING',
        queriesAttempted: 24,
        queriesSucceeded: 22,
        resultsDiscovered: 85,
        searchEvidencePersisted: 45,
        coverage: { queriesCompleted: 22, queriesFailed: 2, failedScopes: [], queryResults: [] },
      });
      const run = repo.getById('run-1');
      assert.ok(run !== null);
      assert.equal(run.phase, 'DISCOVERING');
      assert.equal(run.queriesAttempted, 24);
      assert.equal(run.queriesSucceeded, 22);
      assert.equal(run.resultsDiscovered, 85);
      assert.equal(run.searchEvidencePersisted, 45);
      assert.ok(run.updatedAt >= 100);
    });
  });
});
