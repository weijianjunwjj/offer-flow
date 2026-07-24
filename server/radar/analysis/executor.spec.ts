import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import type { AnalysisTask, JobMatchAnalysisRecord } from '../../../src/domain/radar';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { createQueuedTask, startTask } from './taskStateMachine';
import { AnalysisProviderError } from './provider';
import { AnalysisExecutor, type AnalyzeResult } from './executor';

let tempDir: string;
let db: SqliteDatabase;
let tasks: AnalysisTaskRepository;
let records: AnalysisRecordRepository;
let clock: number;

/** 每次调用 now() 单调递增，满足 updated_at >= created_at 的 CHECK。 */
const now = (): number => (clock += 1);

/** 最小合法 payload（deriveValidity/record schema 不校验 payload 内部，占位对象即可）。 */
const PAYLOAD = { contractVersion: 1 } as unknown as AnalyzeResult['payload'];

/** 组装满足 FK + UNIQUE 的最小 record；依赖测试先建候选/版本/简历。 */
function buildRecord(args: { recordId: string; task: AnalysisTask; result: AnalyzeResult; now: number }): JobMatchAnalysisRecord {
  return {
    id: args.recordId, candidateId: 'cand-1', candidateVersionId: 'cv-1', resumeVersionId: 'rv-1',
    jobMatchProfileVersionId: 'jmp-1', cityCode: null,
    capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
    ruleVersion: 'rule:v1', promptVersion: 'prompt:v1', analysisPolicyVersion: 'policy:v1',
    modelProvider: args.result.provider, modelName: args.result.model, modelVersion: null,
    inputHash: args.task.inputHash, recommendation: 'verify', confidence: 'low',
    payload: args.result.payload, createdAt: args.now, supersedesAnalysisId: null,
  };
}

/** 建 record FK 依赖（radar_candidates / radar_candidate_versions / resume_versions）。 */
function seedFkTargets(): void {
  // 候选与版本互为 FK（active_version_id ↔ candidate_id）：先建 active=NULL 的候选，再建版本，最后回填。
  db.exec(`
    INSERT INTO radar_candidates (id, primary_source_record_id, active_version_id, lifecycle_status, created_at, updated_at)
      VALUES ('cand-1', NULL, NULL, 'active', 1, 1);
    INSERT INTO radar_candidate_versions (id, candidate_id, version_no, normalized_json, quality_issues_json, source_snapshot_ids_json, content_hash, origin_type, created_at)
      VALUES ('cv-1', 'cand-1', 1, '{}', '[]', '[]', 'ch-1', 'captured', 1);
    UPDATE radar_candidates SET active_version_id = 'cv-1' WHERE id = 'cand-1';
    INSERT INTO resume_versions (id, name, source, content_hash, summary, content_json, created_at, idempotency_key, request_hash)
      VALUES ('rv-1', 'r', 'pasted_text', 'rh-1', '', '{}', 1, 'idem-1', 'req-1');
  `);
}

/** 落一个 queued 任务并返回其 id。 */
function seedQueued(id = 'analysis-task:v1:h1', inputHash = 'h1'): string {
  const task = createQueuedTask({
    id, taskType: 'job_match_analysis', entityType: 'radar_candidate_version', entityId: 'cv-1',
    inputHash, inputSnapshot: { k: inputHash }, maxAttempts: 3, now: now(),
  });
  tasks.insertOrGet(task);
  return id;
}

/** 构造执行器：analyze 行为由入参注入；createRecordId 单调。 */
function makeExecutor(analyze: (task: AnalysisTask, signal: AbortSignal) => Promise<AnalyzeResult>): AnalysisExecutor {
  let seq = 0;
  return new AnalysisExecutor({
    db, analyze, buildRecord,
    now,
    createRecordId: () => `rec-${(seq += 1)}`,
  });
}

const successAnalyze = async (): Promise<AnalyzeResult> => ({ payload: PAYLOAD, provider: 'fake', model: 'fake-model' });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-executor-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 7 });
  tasks = new AnalysisTaskRepository(db);
  records = new AnalysisRecordRepository(db);
  clock = 1000;
  seedFkTargets();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runTask — success path (§9)', () => {
  it('claims queued → running → succeeded and writes exactly one record', async () => {
    const id = seedQueued();
    const outcome = await makeExecutor(successAnalyze).runTask(id);
    expect(outcome.kind).toBe('succeeded');
    const task = tasks.getById(id)!;
    expect(task.status).toBe('succeeded');
    expect(task.attemptCount).toBe(1);
    expect(task.resultRecordId).not.toBeNull();
    expect(records.getById(task.resultRecordId!)).not.toBeNull();
  });

  it('reuses the existing record on input_hash conflict instead of inserting a second', async () => {
    // 预置一条同 input_hash 的成功记录，模拟 §3.3 第二层保护命中。
    const id = seedQueued();
    records.insert(buildRecord({ recordId: 'rec-pre', task: tasks.getById(id)!, result: { payload: PAYLOAD, provider: 'fake', model: 'fake-model' }, now: now() }));
    const outcome = await makeExecutor(successAnalyze).runTask(id);
    expect(outcome.kind).toBe('succeeded');
    if (outcome.kind === 'succeeded') {
      expect(outcome.reused).toBe(true);
      expect(outcome.recordId).toBe('rec-pre');
    }
    const count = (db.prepare('SELECT COUNT(*) AS n FROM job_match_analysis_records').get() as { n: number }).n;
    expect(count).toBe(1);
    expect(tasks.getById(id)!.resultRecordId).toBe('rec-pre');
  });

  it('skips a task that is not queued (already running)', async () => {
    const id = seedQueued();
    tasks.transition({ taskId: id, expectedStatus: 'queued', next: startTask(tasks.getById(id)!, { now: now() }) });
    const outcome = await makeExecutor(successAnalyze).runTask(id);
    expect(outcome.kind).toBe('skipped');
  });
});

describe('runTask — failure mapping (§7.3)', () => {
  it.each([
    ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
    ['PROVIDER_NETWORK_ERROR', 'PROVIDER_NETWORK_ERROR'],
    ['PROVIDER_RATE_LIMIT', 'PROVIDER_RATE_LIMIT'],
    ['STRUCTURE_REPAIR_FAILED', 'STRUCTURE_REPAIR_FAILED'],
    ['CONFIGURATION_ERROR', 'CONFIGURATION_ERROR'],
  ] as const)('maps provider %s to task error %s and writes no record', async (providerCode, taskCode) => {
    const id = seedQueued();
    const analyze = async (): Promise<AnalyzeResult> => { throw new AnalysisProviderError(providerCode, 'x'); };
    const outcome = await makeExecutor(analyze).runTask(id);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.errorCode).toBe(taskCode);
    const task = tasks.getById(id)!;
    expect(task.status).toBe('failed');
    expect(task.resultRecordId).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_match_analysis_records').get() as { n: number }).n).toBe(0);
  });

  it('maps sensitive/internal-id leak to SCHEMA_INVALID', async () => {
    const id = seedQueued();
    const analyze = async (): Promise<AnalyzeResult> => { throw new AnalysisProviderError('SENSITIVE_CONTENT_LEAK', 'leak'); };
    const outcome = await makeExecutor(analyze).runTask(id);
    expect(outcome.kind === 'failed' && outcome.errorCode).toBe('SCHEMA_INVALID');
  });

  it('maps a non-provider error to CONFIGURATION_ERROR', async () => {
    const id = seedQueued();
    const analyze = async (): Promise<AnalyzeResult> => { throw new Error('boom'); };
    const outcome = await makeExecutor(analyze).runTask(id);
    expect(outcome.kind === 'failed' && outcome.errorCode).toBe('CONFIGURATION_ERROR');
  });
});

describe('cancel + late result (§8)', () => {
  it('cancel while running aborts the signal and discards a late success (no record)', async () => {
    const id = seedQueued();
    let resolveAnalyze!: (r: AnalyzeResult) => void;
    let observedAbort = false;
    const analyze = (_task: AnalysisTask, signal: AbortSignal): Promise<AnalyzeResult> =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
        resolveAnalyze = resolve;
      });
    const executor = makeExecutor(analyze);
    const run = executor.runTask(id); // 进入 running 并等待 analyze。
    await Promise.resolve();

    const cancelled = executor.cancel(id); // running → cancelled + abort。
    expect(cancelled.status).toBe('cancelled');
    expect(observedAbort).toBe(true);

    resolveAnalyze({ payload: PAYLOAD, provider: 'fake', model: 'fake-model' }); // 迟到成功。
    const outcome = await run;
    expect(outcome.kind).toBe('discarded');
    const task = tasks.getById(id)!;
    expect(task.status).toBe('cancelled');
    expect(task.resultRecordId).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_match_analysis_records').get() as { n: number }).n).toBe(0);
  });

  it('cancel of a queued task lands cancelled without ever running', () => {
    const id = seedQueued();
    const cancelled = makeExecutor(successAnalyze).cancel(id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.attemptCount).toBe(0);
  });

  it('cancel is idempotent and refuses to cancel a succeeded task', async () => {
    const id = seedQueued();
    await makeExecutor(successAnalyze).runTask(id);
    expect(() => makeExecutor(successAnalyze).cancel(id)).toThrow(); // succeeded 不可取消。
  });

  it('a late error after cancel never overwrites cancelled with failed', async () => {
    const id = seedQueued();
    let rejectAnalyze!: (e: unknown) => void;
    const analyze = (_task: AnalysisTask, _signal: AbortSignal): Promise<AnalyzeResult> =>
      new Promise((_resolve, reject) => { rejectAnalyze = reject; });
    const executor = makeExecutor(analyze);
    const run = executor.runTask(id);
    await Promise.resolve();
    executor.cancel(id);
    rejectAnalyze(new AnalysisProviderError('PROVIDER_TIMEOUT', 'late timeout'));
    const outcome = await run;
    expect(outcome.kind).toBe('discarded');
    expect(tasks.getById(id)!.status).toBe('cancelled');
  });
});

describe('recoverOnStartup (§10)', () => {
  it('marks orphaned running as failed(PROCESS_RESTART_INTERRUPTED) and leaves queued for requeue', () => {
    const q = seedQueued('analysis-task:v1:q', 'q');
    const r = seedQueued('analysis-task:v1:r', 'r');
    tasks.transition({ taskId: r, expectedStatus: 'queued', next: startTask(tasks.getById(r)!, { now: now() }) });

    const { interrupted, requeued } = makeExecutor(successAnalyze).recoverOnStartup();
    expect(interrupted).toEqual([r]);
    expect(requeued).toEqual([q]);

    const running = tasks.getById(r)!;
    expect(running.status).toBe('failed');
    expect(running.errorCode).toBe('PROCESS_RESTART_INTERRUPTED');
    expect(running.finishedAt).not.toBeNull();
    expect(tasks.getById(q)!.status).toBe('queued');
  });

  it('is idempotent: a second scan changes nothing', () => {
    const r = seedQueued('analysis-task:v1:r', 'r');
    tasks.transition({ taskId: r, expectedStatus: 'queued', next: startTask(tasks.getById(r)!, { now: now() }) });
    const executor = makeExecutor(successAnalyze);
    executor.recoverOnStartup();
    const second = executor.recoverOnStartup();
    expect(second.interrupted).toEqual([]);
    expect(second.requeued).toEqual([]);
  });

  it('an interrupted task can be retried and run to success from the original snapshot', async () => {
    const r = seedQueued('analysis-task:v1:r', 'r');
    tasks.transition({ taskId: r, expectedStatus: 'queued', next: startTask(tasks.getById(r)!, { now: now() }) });
    const executor = makeExecutor(successAnalyze);
    executor.recoverOnStartup();
    // 人工 retry：failed → queued（attempt 不变 = 1），再次执行 → running(attempt=2) → succeeded。
    const { retryTask } = await import('./taskStateMachine');
    tasks.transition({ taskId: r, expectedStatus: 'failed', next: retryTask(tasks.getById(r)!, { now: now() }) });
    const outcome = await executor.runTask(r);
    expect(outcome.kind).toBe('succeeded');
    expect(tasks.getById(r)!.attemptCount).toBe(2);
  });
});

