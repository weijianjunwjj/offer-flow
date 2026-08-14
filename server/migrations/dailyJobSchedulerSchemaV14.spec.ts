import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_JOB_SCHEDULER_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { SourceRunRepository } from '../source-run/sourceRunRepository';
import type { SourceRun } from '../source-run/types';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-v14-dedupe-'));
let seq = 0;

function withDb(run: (db: Database.Database, repo: SourceRunRepository) => void): void {
  seq += 1;
  const db = openDb(path.join(tempDir, `scenario-${seq}.sqlite3`));
  runMigrations(db, { targetVersion: DAILY_JOB_SCHEDULER_SCHEMA_VERSION });
  const planRepo = new SearchPlanRepository(db);
  planRepo.insertPlan({
    id: 'plan-1', name: 'p', status: 'active', activeVersionId: null,
    createdAt: 1, updatedAt: 1, deletedAt: null,
  });
  planRepo.insertVersion({
    id: 'version-1', searchPlanId: 'plan-1', version: 1,
    cities: [], roleDirections: [], baseKeywords: [], expandedKeywords: [], hardConstraints: [],
    sourceConfigs: [], schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
    scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {},
    notificationPolicy: {}, latestCatchUpTime: '12:00',
    createdAt: 1, activatedAt: 1, supersedesVersionId: null,
  });
  planRepo.setActiveVersion('plan-1', 'version-1');
  run(db, new SourceRunRepository(db));
  db.close();
}

function makeRun(overrides: Partial<SourceRun> = {}): SourceRun {
  return {
    id: 'run-1',
    searchPlanId: 'plan-1',
    searchPlanVersionId: 'version-1',
    scheduledDay: '2026-08-14',
    sourceKey: 'tavily',
    sourceVersion: '1.0.0',
    triggerType: 'SCHEDULED',
    retryOfRunId: null,
    status: 'SUCCEEDED',
    phase: 'DISCOVERING',
    scheduledFor: 1000,
    startedAt: 1000,
    finishedAt: 1000,
    queriesAttempted: 0, queriesSucceeded: 0, queriesFailed: 0, resultsDiscovered: 0, relevantResults: 0,
    newCount: 0, changedCount: 0, duplicateCount: 0, conflictCount: 0, blockedCount: 0,
    searchEvidencePersisted: 0, manualReviewRequired: 0, fullEvidenceCount: 0,
    analysisEligibleCount: 0, analysisRequestedCount: 0, analysisSucceededCount: 0,
    selectedCount: 0, alertedCount: 0, failedCount: 0,
    estimatedSearchCredits: null, actualSearchCredits: null,
    coverage: { queriesCompleted: 0, queriesFailed: 0, failedScopes: [], queryResults: [] },
    progressJson: {}, costSummaryJson: {},
    errorCode: null, errorMessage: null,
    createdAt: 1000, updatedAt: 1000,
    ...overrides,
  };
}

function assertUnique(run: () => void): void {
  assert.throws(run, /UNIQUE constraint failed/);
}

describe('v14 source_runs 持久化去重（FR-005 / FR-007）', () => {
  it('same PlanVersion + scheduledFor，SCHEDULED twice → 只能一条', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun());
      assertUnique(() => repo.insert(makeRun({ id: 'run-2' })));
    });
  });

  it('SCHEDULED + CATCH_UP same PlanVersion + scheduledFor → 只能一条', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun({ triggerType: 'SCHEDULED' }));
      assertUnique(() => repo.insert(makeRun({ id: 'run-2', triggerType: 'CATCH_UP' })));
    });
  });

  it('same PlanVersion + same scheduledDay，CATCH_UP twice → 只能一条', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun({ id: 'run-1', triggerType: 'CATCH_UP', scheduledFor: 1000 }));
      assertUnique(() => repo.insert(makeRun({ id: 'run-2', triggerType: 'CATCH_UP', scheduledFor: 2000 })));
    });
  });

  it('different scheduledFor → 允许下一日 run', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun({ id: 'run-1', scheduledFor: 1000, scheduledDay: '2026-08-14' }));
      repo.insert(makeRun({ id: 'run-2', scheduledFor: 2000, scheduledDay: '2026-08-15' }));
    });
  });

  it('MANUAL / RETRY 不被 occurrence unique 误伤（同 scheduledFor 仍可插入）', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun({ id: 'run-1', triggerType: 'SCHEDULED', scheduledFor: 1000 }));
      // MANUAL 与 RETRY 不受 (version, scheduled_for) partial unique 约束。
      repo.insert(makeRun({ id: 'run-2', triggerType: 'MANUAL', scheduledFor: 1000, scheduledDay: null }));
      repo.insert(makeRun({ id: 'run-3', triggerType: 'RETRY', scheduledFor: 1000, scheduledDay: null }));
    });
  });

  it('FR-007 active concurrency：同 plan 同时最多一个 active run', () => {
    withDb((_db, repo) => {
      repo.insert(makeRun({ id: 'run-1', status: 'RUNNING', finishedAt: null, scheduledFor: 1000 }));
      assertUnique(() => repo.insert(makeRun({ id: 'run-2', status: 'RUNNING', finishedAt: null, scheduledFor: 2000 })));
      // 终态后释放 active 槽位。
      repo.transitionStatus('run-1', { toStatus: 'SUCCEEDED' });
      repo.insert(makeRun({ id: 'run-3', status: 'RUNNING', finishedAt: null, scheduledFor: 3000 }));
    });
  });
});
