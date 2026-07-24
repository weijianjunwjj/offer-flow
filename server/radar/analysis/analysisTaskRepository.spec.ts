import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import type { AnalysisTask } from '../../../src/domain/radar';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { AnalysisTaskDomainError } from './errors';
import { createQueuedTask, markFailed, markSucceeded, startTask } from './taskStateMachine';

let tempDir: string;
let db: SqliteDatabase;
let repo: AnalysisTaskRepository;

function makeQueued(overrides: Partial<Parameters<typeof createQueuedTask>[0]> = {}): AnalysisTask {
  return createQueuedTask({
    id: 'analysis-task:v1:hash-1',
    taskType: 'job_match_analysis',
    entityType: 'radar_candidate_version',
    entityId: 'ver-1',
    inputHash: 'hash-1',
    inputSnapshot: { a: 1, nested: { b: 2 } },
    maxAttempts: 3,
    now: 100,
    ...overrides,
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-task-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  // 分析任务只需 v7 的 analysis_tasks 表；用 v7 目标建库即可。
  initSchema(db, { targetVersion: 7 });
  repo = new AnalysisTaskRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('insertOrGet (deterministic idempotency)', () => {
  it('creates a queued task on first insert', () => {
    const result = repo.insertOrGet(makeQueued());
    expect(result.created).toBe(true);
    expect(repo.getById('analysis-task:v1:hash-1')?.status).toBe('queued');
  });

  it('replays the same task id to the existing row without a second insert', () => {
    repo.insertOrGet(makeQueued());
    const replay = repo.insertOrGet(makeQueued());
    expect(replay.created).toBe(false);
    expect(replay.task.id).toBe('analysis-task:v1:hash-1');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM analysis_tasks').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('rejects same id with a different inputHash', () => {
    repo.insertOrGet(makeQueued());
    try {
      repo.insertOrGet(makeQueued({ inputHash: 'hash-DIFFERENT' }));
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_INPUT_CONFLICT');
    }
  });

  it('rejects same id with a different inputSnapshot', () => {
    repo.insertOrGet(makeQueued());
    try {
      repo.insertOrGet(makeQueued({ inputSnapshot: { a: 999 } }));
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_INPUT_CONFLICT');
    }
  });

  it('treats key-reordered inputSnapshot as byte-equivalent (canonical compare)', () => {
    repo.insertOrGet(makeQueued({ inputSnapshot: { a: 1, nested: { b: 2 } } }));
    const replay = repo.insertOrGet(makeQueued({ inputSnapshot: { nested: { b: 2 }, a: 1 } }));
    expect(replay.created).toBe(false);
  });

  it('findByInputHash returns the single deterministic row', () => {
    repo.insertOrGet(makeQueued());
    expect(repo.findByInputHash('hash-1')?.id).toBe('analysis-task:v1:hash-1');
    expect(repo.findByInputHash('nope')).toBeNull();
  });
});

describe('transition (CAS)', () => {
  function persistedQueued(): AnalysisTask {
    repo.insertOrGet(makeQueued());
    return repo.getById('analysis-task:v1:hash-1')!;
  }

  it('updates when expectedStatus matches', () => {
    const task = persistedQueued();
    const next = startTask(task, { now: 110 });
    expect(repo.transition({ taskId: task.id, expectedStatus: 'queued', next })).toBe(true);
    expect(repo.getById(task.id)?.status).toBe('running');
    expect(repo.getById(task.id)?.attemptCount).toBe(1);
  });

  it('updates 0 rows when expectedStatus is wrong', () => {
    const task = persistedQueued();
    const next = startTask(task, { now: 110 });
    expect(repo.transition({ taskId: task.id, expectedStatus: 'running', next })).toBe(false);
    expect(repo.getById(task.id)?.status).toBe('queued');
  });

  it('updates 0 rows when expectedAttemptCount is wrong', () => {
    const task = persistedQueued();
    const next = startTask(task, { now: 110 });
    expect(repo.transition({ taskId: task.id, expectedStatus: 'queued', expectedAttemptCount: 5, next })).toBe(false);
    expect(repo.getById(task.id)?.status).toBe('queued');
  });

  it('prevents a stale running executor from overwriting an already-cancelled task', () => {
    const task = persistedQueued();
    const running = startTask(task, { now: 110 });
    repo.transition({ taskId: task.id, expectedStatus: 'queued', next: running });
    // 取消发生（running → cancelled）。
    const cancelled: AnalysisTask = {
      ...running, status: 'cancelled', cancelledAt: 120, errorCode: 'CANCELLED_BY_USER', updatedAt: 120,
    };
    expect(repo.transition({ taskId: task.id, expectedStatus: 'running', next: cancelled })).toBe(true);
    // 旧执行器带着 running→succeeded 迟到写入，expectedStatus=running 不再匹配。
    const succeeded = markSucceeded(running, { now: 130, resultRecordId: 'record-late' });
    expect(repo.transition({ taskId: task.id, expectedStatus: 'running', next: succeeded })).toBe(false);
    const final = repo.getById(task.id)!;
    expect(final.status).toBe('cancelled');
    expect(final.resultRecordId).toBeNull();
  });

  it('prevents a stale executor from overwriting state after failed→queued retry', () => {
    const task = persistedQueued();
    const running = startTask(task, { now: 110 });
    repo.transition({ taskId: task.id, expectedStatus: 'queued', next: running });
    const failed = markFailed(running, { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    repo.transition({ taskId: task.id, expectedStatus: 'running', next: failed });
    // retry：failed → queued（attemptCount 不变 = 1）。
    const requeued: AnalysisTask = {
      ...failed, status: 'queued', startedAt: null, finishedAt: null, errorCode: null, errorMessage: null, updatedAt: 200,
    };
    expect(repo.transition({ taskId: task.id, expectedStatus: 'failed', next: requeued })).toBe(true);
    // 旧执行器仍以为处于 running，尝试 markFailed 覆盖，被 CAS 拒绝。
    const staleFail = { ...failed, updatedAt: 210 };
    expect(repo.transition({ taskId: task.id, expectedStatus: 'running', next: staleFail })).toBe(false);
    expect(repo.getById(task.id)?.status).toBe('queued');
  });

  it('never mutates immutable columns across transitions', () => {
    const task = persistedQueued();
    const before = repo.getById(task.id)!;
    const running = startTask(task, { now: 110 });
    repo.transition({ taskId: task.id, expectedStatus: 'queued', next: running });
    const succeeded = markSucceeded(running, { now: 130, resultRecordId: 'record-1' });
    // 需要一条 succeeded 记录满足 result_record_id FK？result_record_id 无 FK，直接写。
    repo.transition({ taskId: task.id, expectedStatus: 'running', next: succeeded });
    const after = repo.getById(task.id)!;
    expect(after.inputHash).toBe(before.inputHash);
    expect(after.inputSnapshot).toEqual(before.inputSnapshot);
    expect(after.entityId).toBe(before.entityId);
    expect(after.taskType).toBe(before.taskType);
    expect(after.maxAttempts).toBe(before.maxAttempts);
    expect(after.createdAt).toBe(before.createdAt);
  });
});

describe('listRecoverable', () => {
  it('returns only queued and running tasks', () => {
    repo.insertOrGet(makeQueued({ id: 'analysis-task:v1:q', inputHash: 'q' }));

    repo.insertOrGet(makeQueued({ id: 'analysis-task:v1:r', inputHash: 'r' }));
    const r = repo.getById('analysis-task:v1:r')!;
    repo.transition({ taskId: r.id, expectedStatus: 'queued', next: startTask(r, { now: 110 }) });

    repo.insertOrGet(makeQueued({ id: 'analysis-task:v1:s', inputHash: 's' }));
    const s = repo.getById('analysis-task:v1:s')!;
    const sRunning = startTask(s, { now: 110 });
    repo.transition({ taskId: s.id, expectedStatus: 'queued', next: sRunning });
    repo.transition({ taskId: s.id, expectedStatus: 'running', next: markSucceeded(sRunning, { now: 130, resultRecordId: 'rec-s' }) });

    repo.insertOrGet(makeQueued({ id: 'analysis-task:v1:f', inputHash: 'f' }));
    const f = repo.getById('analysis-task:v1:f')!;
    const fRunning = startTask(f, { now: 110 });
    repo.transition({ taskId: f.id, expectedStatus: 'queued', next: fRunning });
    repo.transition({ taskId: f.id, expectedStatus: 'running', next: markFailed(fRunning, { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' }) });

    const recoverable = repo.listRecoverable().map((t) => t.id).sort();
    expect(recoverable).toEqual(['analysis-task:v1:q', 'analysis-task:v1:r']);
  });
});
