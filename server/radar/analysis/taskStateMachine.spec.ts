import { describe, expect, it } from 'vitest';
import type { AnalysisTask } from '../../../src/domain/radar';
import { AnalysisTaskDomainError } from './errors';
import {
  cancelTask,
  createQueuedTask,
  interruptRunningTask,
  markFailed,
  markSucceeded,
  retryTask,
  startTask,
} from './taskStateMachine';

function queued(overrides: Partial<AnalysisTask> = {}): AnalysisTask {
  return {
    ...createQueuedTask({
      id: 'analysis-task:v1:hash-1',
      taskType: 'job_match_analysis',
      entityType: 'radar_candidate_version',
      entityId: 'ver-1',
      inputHash: 'hash-1',
      inputSnapshot: { a: 1 },
      maxAttempts: 3,
      now: 100,
    }),
    ...overrides,
  };
}

/** 迁移前后必须逐字段不变的不可变列。 */
const IMMUTABLE_KEYS = [
  'inputHash', 'inputSnapshot', 'entityId', 'taskType', 'maxAttempts', 'createdAt',
] as const;

function expectImmutable(before: AnalysisTask, after: AnalysisTask): void {
  for (const key of IMMUTABLE_KEYS) {
    expect(after[key]).toEqual(before[key]);
  }
}

describe('createQueuedTask', () => {
  it('starts queued with attemptCount 0 and no lifecycle timestamps', () => {
    const task = queued();
    expect(task.status).toBe('queued');
    expect(task.attemptCount).toBe(0);
    expect(task.startedAt).toBeNull();
    expect(task.finishedAt).toBeNull();
    expect(task.cancelledAt).toBeNull();
    expect(task.resultRecordId).toBeNull();
  });
});

describe('startTask', () => {
  it('queued → running increments attemptCount 0→1 and sets startedAt', () => {
    const before = queued();
    const after = startTask(before, { now: 110 });
    expect(after.status).toBe('running');
    expect(after.attemptCount).toBe(1);
    expect(after.startedAt).toBe(110);
    expectImmutable(before, after);
  });

  it('rejects start when attemptCount already at maxAttempts', () => {
    const task = queued({ attemptCount: 3, maxAttempts: 3 });
    expect(() => startTask(task, { now: 110 })).toThrow(AnalysisTaskDomainError);
    try {
      startTask(task, { now: 110 });
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_ATTEMPTS_EXHAUSTED');
    }
  });

  it('rejects start from running (no attemptCount double increment)', () => {
    const running = startTask(queued(), { now: 110 });
    expect(() => startTask(running, { now: 120 })).toThrow(/running/);
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('rejects start from %s', (status) => {
    expect(() => startTask(queued({ status }), { now: 110 })).toThrow(AnalysisTaskDomainError);
  });
});

describe('markSucceeded', () => {
  it('running → succeeded sets finishedAt/resultRecordId and clears error fields', () => {
    const running = startTask(queued(), { now: 110 });
    const after = markSucceeded(running, { now: 130, resultRecordId: 'record-1' });
    expect(after.status).toBe('succeeded');
    expect(after.finishedAt).toBe(130);
    expect(after.resultRecordId).toBe('record-1');
    expect(after.errorCode).toBeNull();
    expect(after.errorMessage).toBeNull();
    expectImmutable(running, after);
  });

  it('is idempotent for repeat success with same resultRecordId', () => {
    const succeeded = markSucceeded(startTask(queued(), { now: 110 }), { now: 130, resultRecordId: 'record-1' });
    const again = markSucceeded(succeeded, { now: 200, resultRecordId: 'record-1' });
    expect(again).toEqual(succeeded);
  });

  it('conflicts when repeat success carries a different resultRecordId', () => {
    const succeeded = markSucceeded(startTask(queued(), { now: 110 }), { now: 130, resultRecordId: 'record-1' });
    try {
      markSucceeded(succeeded, { now: 200, resultRecordId: 'record-2' });
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_RESULT_CONFLICT');
    }
  });

  it.each(['queued', 'failed', 'cancelled'] as const)('rejects markSucceeded from %s', (status) => {
    expect(() => markSucceeded(queued({ status }), { now: 130, resultRecordId: 'r' })).toThrow(AnalysisTaskDomainError);
  });
});

describe('markFailed', () => {
  it('running → failed sets error fields and keeps resultRecordId null', () => {
    const running = startTask(queued(), { now: 110 });
    const after = markFailed(running, { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'timeout' });
    expect(after.status).toBe('failed');
    expect(after.finishedAt).toBe(130);
    expect(after.errorCode).toBe('PROVIDER_TIMEOUT');
    expect(after.resultRecordId).toBeNull();
    expectImmutable(running, after);
  });

  it('failed → failed is rejected (no overwrite of original failure)', () => {
    const failed = markFailed(startTask(queued(), { now: 110 }), { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    expect(() => markFailed(failed, { now: 140, errorCode: 'SCHEMA_INVALID', errorMessage: 'y' })).toThrow(/failed/);
  });
});

describe('interruptRunningTask', () => {
  it('running → failed with PROCESS_RESTART_INTERRUPTED', () => {
    const running = startTask(queued(), { now: 110 });
    const after = interruptRunningTask(running, { now: 500 });
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('PROCESS_RESTART_INTERRUPTED');
    expect(after.finishedAt).toBe(500);
  });

  it('rejects interrupt from non-running', () => {
    expect(() => interruptRunningTask(queued(), { now: 500 })).toThrow(AnalysisTaskDomainError);
  });
});

describe('cancelTask', () => {
  it('queued → cancelled keeps attemptCount 0 and anchors startedAt=cancelledAt', () => {
    const before = queued();
    const after = cancelTask(before, { now: 120 });
    expect(after.status).toBe('cancelled');
    expect(after.attemptCount).toBe(0);
    expect(after.startedAt).toBe(120);
    expect(after.cancelledAt).toBe(120);
    expect(after.resultRecordId).toBeNull();
    expectImmutable(before, after);
  });

  it('running → cancelled preserves original startedAt and attemptCount', () => {
    const running = startTask(queued(), { now: 110 });
    const after = cancelTask(running, { now: 120 });
    expect(after.status).toBe('cancelled');
    expect(after.startedAt).toBe(110);
    expect(after.attemptCount).toBe(1);
    expect(after.cancelledAt).toBe(120);
  });

  it('cancelled → cancelled is idempotent (no timestamp change)', () => {
    const cancelled = cancelTask(queued(), { now: 120 });
    const again = cancelTask(cancelled, { now: 999 });
    expect(again).toEqual(cancelled);
  });

  it('rejects cancel of a succeeded task', () => {
    const succeeded = markSucceeded(startTask(queued(), { now: 110 }), { now: 130, resultRecordId: 'r' });
    try {
      cancelTask(succeeded, { now: 200 });
      throw new Error('expected conflict');
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_STATE_CONFLICT');
    }
  });

  it('rejects cancel from failed', () => {
    const failed = markFailed(startTask(queued(), { now: 110 }), { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    expect(() => cancelTask(failed, { now: 200 })).toThrow(AnalysisTaskDomainError);
  });
});

describe('retryTask', () => {
  it('failed → queued keeps attemptCount and reuses input', () => {
    const failed = markFailed(startTask(queued(), { now: 110 }), { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    const requeued = retryTask(failed, { now: 200 });
    expect(requeued.status).toBe('queued');
    expect(requeued.attemptCount).toBe(1);
    expect(requeued.startedAt).toBeNull();
    expect(requeued.finishedAt).toBeNull();
    expect(requeued.errorCode).toBeNull();
    expectImmutable(failed, requeued);
  });

  it('increments attemptCount only when retried task starts running again', () => {
    const failed = markFailed(startTask(queued(), { now: 110 }), { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    const requeued = retryTask(failed, { now: 200 });
    expect(requeued.attemptCount).toBe(1);
    const running2 = startTask(requeued, { now: 210 });
    expect(running2.attemptCount).toBe(2);
  });

  it('rejects retry once attemptCount reaches maxAttempts', () => {
    const failed = queued({ status: 'failed', attemptCount: 3, maxAttempts: 3, startedAt: 110, finishedAt: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    try {
      retryTask(failed, { now: 200 });
      throw new Error('expected exhausted');
    } catch (error) {
      expect((error as AnalysisTaskDomainError).code).toBe('TASK_ATTEMPTS_EXHAUSTED');
    }
  });

  it.each(['queued', 'running', 'succeeded', 'cancelled'] as const)('rejects retry from %s', (status) => {
    expect(() => retryTask(queued({ status }), { now: 200 })).toThrow(AnalysisTaskDomainError);
  });
});

describe('illegal transitions matrix', () => {
  it('succeeded cannot be cancelled or retried; queued cannot succeed/fail; failed cannot start', () => {
    const succeeded = markSucceeded(startTask(queued(), { now: 110 }), { now: 130, resultRecordId: 'r' });
    expect(() => cancelTask(succeeded, { now: 200 })).toThrow();
    expect(() => retryTask(succeeded, { now: 200 })).toThrow();
    expect(() => markSucceeded(queued(), { now: 130, resultRecordId: 'r' })).toThrow();
    expect(() => markFailed(queued(), { now: 130, errorCode: 'SCHEMA_INVALID', errorMessage: 'x' })).toThrow();
    const failed = markFailed(startTask(queued(), { now: 110 }), { now: 130, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' });
    expect(() => startTask(failed, { now: 200 })).toThrow(/failed/);
    const cancelled = cancelTask(queued(), { now: 120 });
    expect(() => retryTask(cancelled, { now: 200 })).toThrow();
  });
});
