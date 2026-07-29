import type { AnalysisTask, AnalysisTaskErrorCode } from '../../../src/domain/radar';
import { AnalysisTaskSchema } from '../../../src/domain/radar';
import {
  attemptsExhausted,
  invalidTransition,
  resultConflict,
  stateConflict,
} from './errors';

/**
 * V8-4 可靠单岗位分析 · 纯任务状态机（无 I/O、无时间副作用）。
 *
 * 每个命令接收当前 AnalysisTask（或创建参数）与 { now } 等显式入参，
 * 返回**目标状态的完整 AnalysisTask**（供 Repository CAS 落库），非法输入抛
 * AnalysisTaskDomainError。业务状态规则集中在此，Repository 只负责条件持久化。
 *
 * attemptCount 语义（设计 §5，已冻结）：
 * - 表示「已开始执行的次数」；
 * - 新建 queued：attemptCount = 0；
 * - queued → running：attemptCount + 1；
 * - failed → queued（retry）：attemptCount 不变，复用原 inputHash/inputSnapshot；
 * - retry 后再次 running 时才 +1；
 * - attemptCount >= maxAttempts：不得再进入 running。
 *
 * 合法迁移：queued→running / queued→cancelled / running→succeeded /
 * running→failed / running→cancelled / failed→queued。
 * cancelled→queued（复活）本波次视为非法，留待执行器/服务波次实现（见设计 §4.4 注）。
 *
 * 不可变字段（taskType/entityType/entityId/inputHash/inputSnapshot/maxAttempts/createdAt）
 * 由各命令原样透传，任何命令都不得改写。
 */

export interface CreateQueuedTaskParams {
  id: string;
  taskType: AnalysisTask['taskType'];
  entityType: string;
  entityId: string;
  inputHash: string;
  inputSnapshot: unknown;
  maxAttempts?: number;
  now: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/** 校验并冻结目标状态，任何越过 SQLite CHECK 的组合在此提前失败。 */
function freeze(task: AnalysisTask): AnalysisTask {
  return AnalysisTaskSchema.parse(task);
}

export function createQueuedTask(params: CreateQueuedTaskParams): AnalysisTask {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return freeze({
    id: params.id,
    taskType: params.taskType,
    entityType: params.entityType,
    entityId: params.entityId,
    status: 'queued',
    inputHash: params.inputHash,
    inputSnapshot: params.inputSnapshot,
    attemptCount: 0,
    maxAttempts,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    errorCode: null,
    errorMessage: null,
    resultRecordId: null,
    createdAt: params.now,
    updatedAt: params.now,
  });
}

/** queued → running：递增执行次数并写 started_at；受 maxAttempts 门禁。 */
export function startTask(task: AnalysisTask, opts: { now: number }): AnalysisTask {
  if (task.status !== 'queued') throw invalidTransition(task.status, 'start');
  if (task.attemptCount >= task.maxAttempts) {
    throw attemptsExhausted(task.attemptCount, task.maxAttempts);
  }
  return freeze({
    ...task,
    status: 'running',
    attemptCount: task.attemptCount + 1,
    startedAt: opts.now,
    updatedAt: opts.now,
  });
}

/**
 * running → succeeded。要求 resultRecordId 非空、finished_at 非空、错误字段清空。
 * 幂等：已 succeeded 且 resultRecordId 相同 → 原样返回；不同 → TASK_RESULT_CONFLICT。
 */
export function markSucceeded(
  task: AnalysisTask,
  opts: { now: number; resultRecordId: string },
): AnalysisTask {
  if (task.status === 'succeeded') {
    if (task.resultRecordId === opts.resultRecordId) return task;
    throw resultConflict();
  }
  if (task.status !== 'running') throw invalidTransition(task.status, 'markSucceeded');
  return freeze({
    ...task,
    status: 'succeeded',
    finishedAt: opts.now,
    resultRecordId: opts.resultRecordId,
    errorCode: null,
    errorMessage: null,
    updatedAt: opts.now,
  });
}

/**
 * running → failed。要求 error_code 非空、finished_at 非空、result_record_id 为 NULL。
 * failed → failed 不得覆盖原失败（INVALID_TASK_TRANSITION）。
 */
export function markFailed(
  task: AnalysisTask,
  opts: { now: number; errorCode: AnalysisTaskErrorCode; errorMessage: string },
): AnalysisTask {
  if (task.status !== 'running') throw invalidTransition(task.status, 'markFailed');
  return freeze({
    ...task,
    status: 'failed',
    finishedAt: opts.now,
    errorCode: opts.errorCode,
    errorMessage: opts.errorMessage,
    resultRecordId: null,
    updatedAt: opts.now,
  });
}

/**
 * running → failed，error_code = PROCESS_RESTART_INTERRUPTED（进程重启恢复扫描）。
 * 不冒充断点续跑：仅把中断的 running 标记为 failed，由用户后续人工 retry。
 */
export function interruptRunningTask(task: AnalysisTask, opts: { now: number }): AnalysisTask {
  if (task.status !== 'running') throw invalidTransition(task.status, 'interrupt');
  return markFailed(task, {
    now: opts.now,
    errorCode: 'PROCESS_RESTART_INTERRUPTED',
    errorMessage: '进程重启导致运行中任务中断，可人工重试',
  });
}

/**
 * queued/running → cancelled。幂等：已 cancelled → 原样返回（不改时间戳）。
 *
 * SQLite CHECK 要求 cancelled 的 started_at 非空。queued 尚未开始执行，
 * 此处把 startedAt 与 cancelledAt 同置为 now，作为**任务生命周期终止锚点**，
 * 不代表 Provider 已被调用；attemptCount 保持 0。
 */
export function cancelTask(task: AnalysisTask, opts: { now: number }): AnalysisTask {
  if (task.status === 'cancelled') return task;
  if (task.status === 'succeeded') throw stateConflict('已成功的任务不可取消');
  if (task.status !== 'queued' && task.status !== 'running') {
    throw invalidTransition(task.status, 'cancel');
  }
  return freeze({
    ...task,
    status: 'cancelled',
    startedAt: task.startedAt ?? opts.now,
    cancelledAt: opts.now,
    errorCode: 'CANCELLED_BY_USER',
    resultRecordId: null,
    updatedAt: opts.now,
  });
}

/**
 * failed → queued（人工 retry）。attemptCount 不变；复用原 inputHash/inputSnapshot。
 * attemptCount >= maxAttempts 时拒绝（避免产生永远无法进入 running 的僵尸 queued）。
 */
export function retryTask(task: AnalysisTask, opts: { now: number }): AnalysisTask {
  if (task.status !== 'failed') throw invalidTransition(task.status, 'retry');
  if (task.attemptCount >= task.maxAttempts) {
    throw attemptsExhausted(task.attemptCount, task.maxAttempts);
  }
  return freeze({
    ...task,
    status: 'queued',
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    errorCode: null,
    errorMessage: null,
    resultRecordId: null,
    updatedAt: opts.now,
  });
}
