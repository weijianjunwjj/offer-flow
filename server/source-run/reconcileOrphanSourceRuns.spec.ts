import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { reconcileOrphanSourceRuns } from './reconcileOrphanSourceRuns';
import { SourceRunRepository } from './sourceRunRepository';
import type { SourceRun } from './types';

describe('reconcileOrphanSourceRuns', () => {
  let db: Database.Database;
  let repo: SourceRunRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    // 最小 schema（仅 source_runs 表）
    db.exec(`
      CREATE TABLE source_runs (
        id TEXT PRIMARY KEY,
        search_plan_id TEXT NOT NULL,
        search_plan_version_id TEXT NOT NULL,
        scheduled_day TEXT,
        source_key TEXT NOT NULL,
        source_version TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        retry_of_run_id TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        queries_attempted INTEGER NOT NULL DEFAULT 0,
        queries_succeeded INTEGER NOT NULL DEFAULT 0,
        queries_failed INTEGER NOT NULL DEFAULT 0,
        results_discovered INTEGER NOT NULL DEFAULT 0,
        relevant_results INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        changed_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        blocked_count INTEGER NOT NULL DEFAULT 0,
        search_evidence_persisted INTEGER NOT NULL DEFAULT 0,
        manual_review_required INTEGER NOT NULL DEFAULT 0,
        full_evidence_count INTEGER NOT NULL DEFAULT 0,
        analysis_eligible_count INTEGER NOT NULL DEFAULT 0,
        analysis_requested_count INTEGER NOT NULL DEFAULT 0,
        analysis_succeeded_count INTEGER NOT NULL DEFAULT 0,
        selected_count INTEGER NOT NULL DEFAULT 0,
        alerted_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        estimated_search_credits INTEGER,
        actual_search_credits INTEGER,
        coverage_json TEXT NOT NULL DEFAULT '{}',
        progress_json TEXT NOT NULL DEFAULT '{}',
        cost_summary_json TEXT NOT NULL DEFAULT '{}',
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    repo = new SourceRunRepository(db);
  });

  function createRun(overrides: Partial<SourceRun> = {}): SourceRun {
    return {
      id: `run-${Date.now()}-${Math.random()}`,
      searchPlanId: 'plan-1',
      searchPlanVersionId: 'version-1',
      scheduledDay: '2026-08-20',
      sourceKey: 'tavily',
      sourceVersion: '1.0',
      triggerType: 'SCHEDULED',
      retryOfRunId: null,
      status: 'RUNNING',
      phase: 'DISCOVERING',
      scheduledFor: Date.now(),
      startedAt: Date.now(),
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('should transition orphan RUNNING to INTERRUPTED', () => {
    const run = createRun({ id: 'run-1', status: 'RUNNING', finishedAt: null });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-1');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('INTERRUPTED');
    expect(after!.finishedAt).not.toBeNull();
    expect(after!.errorCode).toBe('PROCESS_RESTART');
    expect(after!.errorMessage).toBe('Process terminated before completion');
  });

  it('should transition orphan PENDING to INTERRUPTED', () => {
    const run = createRun({ id: 'run-2', status: 'PENDING', finishedAt: null, startedAt: null });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-2');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('INTERRUPTED');
    expect(after!.finishedAt).not.toBeNull();
    expect(after!.errorCode).toBe('PROCESS_RESTART');
  });

  it('should preserve WAITING_FOR_USER status', () => {
    const run = createRun({ id: 'run-3', status: 'WAITING_FOR_USER', finishedAt: null });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-3');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('WAITING_FOR_USER');
    expect(after!.finishedAt).toBeNull();
  });

  it('should not modify SUCCEEDED runs', () => {
    const run = createRun({ id: 'run-4', status: 'SUCCEEDED', finishedAt: Date.now() });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-4');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('SUCCEEDED');
  });

  it('should not modify FAILED runs', () => {
    const run = createRun({ id: 'run-5', status: 'FAILED', finishedAt: Date.now() });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-5');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('FAILED');
  });

  it('should not modify already INTERRUPTED runs', () => {
    const originalFinishedAt = Date.now() - 10000;
    const run = createRun({
      id: 'run-6',
      status: 'INTERRUPTED',
      finishedAt: originalFinishedAt,
      errorCode: 'MANUAL_STOP',
    });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);

    const after = repo.getById('run-6');
    expect(after).not.toBeNull();
    expect(after!.status).toBe('INTERRUPTED');
    expect(after!.finishedAt).toBe(originalFinishedAt);
    expect(after!.errorCode).toBe('MANUAL_STOP');
  });

  it('should be idempotent on repeated calls', () => {
    const run = createRun({ id: 'run-7', status: 'RUNNING', finishedAt: null });
    repo.insert(run);

    reconcileOrphanSourceRuns(db);
    const firstPass = repo.getById('run-7');
    const firstFinishedAt = firstPass!.finishedAt;

    // 第二次调用
    reconcileOrphanSourceRuns(db);
    const secondPass = repo.getById('run-7');

    expect(secondPass!.status).toBe('INTERRUPTED');
    expect(secondPass!.finishedAt).toBe(firstFinishedAt); // 幂等：finished_at 不变
    expect(secondPass!.errorCode).toBe('PROCESS_RESTART');
  });

  it('should handle multiple orphans simultaneously', () => {
    const run1 = createRun({ id: 'run-8', status: 'RUNNING', finishedAt: null });
    const run2 = createRun({ id: 'run-9', status: 'PENDING', finishedAt: null, startedAt: null });
    const run3 = createRun({ id: 'run-10', status: 'SUCCEEDED', finishedAt: Date.now() });

    repo.insert(run1);
    repo.insert(run2);
    repo.insert(run3);

    reconcileOrphanSourceRuns(db);

    expect(repo.getById('run-8')!.status).toBe('INTERRUPTED');
    expect(repo.getById('run-9')!.status).toBe('INTERRUPTED');
    expect(repo.getById('run-10')!.status).toBe('SUCCEEDED');
  });

  it('should not fail when no orphans exist', () => {
    const run = createRun({ id: 'run-11', status: 'SUCCEEDED', finishedAt: Date.now() });
    repo.insert(run);

    expect(() => reconcileOrphanSourceRuns(db)).not.toThrow();

    const after = repo.getById('run-11');
    expect(after!.status).toBe('SUCCEEDED');
  });

  it('should handle empty database gracefully', () => {
    expect(() => reconcileOrphanSourceRuns(db)).not.toThrow();
  });
});
