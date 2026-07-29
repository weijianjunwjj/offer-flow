/**
 * V8-4 单岗位分析 · 执行器（设计 §8 取消/迟到、§9 原子成功写入、§10 进程恢复）。
 *
 * 职责边界：执行器只负责**可靠性语义**——领取任务、登记取消、原子写入、恢复扫描；
 * 不组装 LLM 输入、不调用 Provider transport（由注入的 analyze 边界完成），
 * 不组装 Envelope 版本字段（由注入的 buildRecord 完成，服务波次提供）。
 *
 * 三条硬保证：
 * 1. 取消先事务性落 cancelled，再 abort；返回后重读，**非 running 绝不写 record**（§8.2/§8.3）；
 * 2. running→succeeded 在单事务内"再读确认 running → insertOrGet(byInputHash) → CAS 置 succeeded"，
 *    任一步失败整体回滚，task 保持 running，由外层置 failed（RESULT_WRITE_FAILED），绝不误标 succeeded（§9）；
 * 3. 恢复扫描把遗留 running 标记 failed(PROCESS_RESTART_INTERRUPTED)，queued 交回执行，幂等（§10）。
 */
import type { AnalysisTask, AnalysisTaskErrorCode, JobMatchAnalysisRecord } from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { AnalysisProviderError, type AnalysisProviderErrorCode } from './provider';
import type { AnalysisValidationIssue } from './contractErrors';
import type { JobMatchAnalysisPayloadV1 } from './analysisPayload';
import {
  cancelTask,
  interruptRunningTask,
  markFailed,
  markSucceeded,
  startTask,
} from './taskStateMachine';
import { invalidTransition, stateConflict } from './errors';

/** analyze 边界产物：脱敏 Payload + Provider/模型元数据（供 buildRecord 组装 Envelope）。 */
export interface AnalyzeResult {
  payload: JobMatchAnalysisPayloadV1;
  provider: string;
  model: string;
}

/** 注入依赖：analyze（Provider 编排边界）、buildRecord（Envelope 组装）、时间与 ID 生成。 */
export interface AnalysisExecutorDeps {
  db: SqliteDatabase;
  /** 调用 Provider 生成 + 一次结构修复，必须尊重 signal；抛 AnalysisProviderError 表达安全终态。 */
  analyze: (task: AnalysisTask, signal: AbortSignal) => Promise<AnalyzeResult>;
  /** 组装不可变 JobMatchAnalysisRecord（含全部 Envelope 版本字段与 input_hash=task.inputHash）。 */
  buildRecord: (args: {
    recordId: string;
    task: AnalysisTask;
    result: AnalyzeResult;
    now: number;
  }) => JobMatchAnalysisRecord;
  now: () => number;
  createRecordId: () => string;
}

/** runTask 结果：区分成功写入、迟到丢弃、失败终态，便于服务层与测试断言。 */
export type RunOutcome =
  | { kind: 'succeeded'; task: AnalysisTask; recordId: string; reused: boolean }
  | { kind: 'discarded'; task: AnalysisTask; reason: 'not_running_after_return' }
  | { kind: 'failed'; task: AnalysisTask; errorCode: AnalysisTaskErrorCode }
  | { kind: 'skipped'; task: AnalysisTask; reason: 'not_claimable' };

/** Provider 安全错误码 → 任务终态错误码。泄漏类无独立任务码，归 SCHEMA_INVALID（不可修复的结构/内容问题）。 */
const PROVIDER_TO_TASK_ERROR: Record<AnalysisProviderErrorCode, AnalysisTaskErrorCode> = {
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_NETWORK_ERROR: 'PROVIDER_NETWORK_ERROR',
  PROVIDER_RATE_LIMIT: 'PROVIDER_RATE_LIMIT',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  STRUCTURE_REPAIR_FAILED: 'STRUCTURE_REPAIR_FAILED',
  CANCELLED_BY_USER: 'CANCELLED_BY_USER',
  SENSITIVE_CONTENT_LEAK: 'SCHEMA_INVALID',
  INTERNAL_ID_LEAK: 'SCHEMA_INVALID',
};

/** error_message 落库上限：保留具体失败摘要又不至于无界。error_message 列无 CHECK，可安全承载。 */
const ERROR_MESSAGE_MAX = 1_000;

/**
 * 由稳定语义 + 脱敏 issues 组装**具体**失败摘要，替代泛化文案。
 * 绝不含 rawText / Prompt / JD / 敏感值：issues 已在解析层脱敏（仅 path + code + 稳定 message）。
 */
function buildFailureMessage(
  base: string,
  detail: string | undefined,
  issues: readonly AnalysisValidationIssue[] | undefined,
): string {
  // detail 承载稳定契约错误码（如 ANALYSIS_JSON_INVALID）；JSON 解析失败无逐条 issues 时仍能定位。
  const codePart = detail !== undefined && detail !== '' ? `（${detail}）` : '';
  if (issues === undefined || issues.length === 0) {
    return `${base}${codePart}`.slice(0, ERROR_MESSAGE_MAX);
  }
  const lines = issues.map((i) => `· ${i.path !== '' ? i.path : '(根对象)'}：${i.code} ${i.message}`);
  return `${base}${codePart}｜具体问题：${lines.join('；')}`.slice(0, ERROR_MESSAGE_MAX);
}

/**
 * 把 analyze 抛出的错误映射为安全终态码；非 AnalysisProviderError 归 CONFIGURATION_ERROR（内部管线异常，可人工重试）。
 * 结构/校验类错误附带脱敏 issues，使失败任务展示“具体哪里不合契约”，而非泛化“结构修复失败”。
 */
function classifyAnalyzeError(error: unknown): { errorCode: AnalysisTaskErrorCode; message: string } {
  if (error instanceof AnalysisProviderError) {
    return {
      errorCode: PROVIDER_TO_TASK_ERROR[error.code],
      message: buildFailureMessage(error.message, error.detail, error.issues),
    };
  }
  return { errorCode: 'CONFIGURATION_ERROR', message: '分析执行遇到内部错误，可人工重试' };
}

export class AnalysisExecutor {
  private readonly tasks: AnalysisTaskRepository;
  private readonly records: AnalysisRecordRepository;
  /** 进程内取消登记：仅在本进程 running 期间存在；进程重启后为空，由恢复扫描兜底（§8.1）。 */
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: AnalysisExecutorDeps) {
    this.tasks = new AnalysisTaskRepository(deps.db);
    this.records = new AnalysisRecordRepository(deps.db);
  }

  /**
   * 领取并执行一个 queued 任务，直到终态或迟到丢弃。
   * queued→running 用 CAS 领取（并发下只有一个执行器成功）；随后调用 analyze，
   * 按 §8/§9 处理取消/迟到/原子写入/失败。
   */
  async runTask(taskId: string): Promise<RunOutcome> {
    const claimed = this.claim(taskId);
    if (claimed === null) {
      const current = this.tasks.getById(taskId);
      return { kind: 'skipped', task: current!, reason: 'not_claimable' };
    }
    const { task, controller } = claimed;
    try {
      const result = await this.deps.analyze(task, controller.signal);
      return this.finishWithResult(task, result);
    } catch (error) {
      return this.finishWithError(task, error);
    } finally {
      this.inflight.delete(task.id);
    }
  }

  /** queued→running CAS 领取；成功登记 AbortController，返回 running 任务；不可领取返回 null。 */
  private claim(taskId: string): { task: AnalysisTask; controller: AbortController } | null {
    const current = this.tasks.getById(taskId);
    if (current === null || current.status !== 'queued') return null;
    const running = startTask(current, { now: this.deps.now() });
    const controller = new AbortController();
    // 先登记再 CAS：CAS 失败要回收，避免登记泄漏。
    this.inflight.set(taskId, controller);
    const ok = this.tasks.transition({
      taskId, expectedStatus: 'queued', expectedAttemptCount: current.attemptCount, next: running,
    });
    if (!ok) {
      this.inflight.delete(taskId);
      return null;
    }
    return { task: running, controller };
  }

  /**
   * §9 原子成功写入。单事务内：再读确认 running → insertOrGet(byInputHash) → CAS 置 succeeded。
   * 非 running（已取消/失败）→ 丢弃结果，绝不写 record（§8.3 迟到保证）。
   * 事务内任一步抛出 → 整体回滚，外层置 failed(RESULT_WRITE_FAILED)，绝不误标 succeeded。
   */
  private finishWithResult(task: AnalysisTask, result: AnalyzeResult): RunOutcome {
    const now = this.deps.now();
    const recordId = this.deps.createRecordId();
    const record = this.deps.buildRecord({ recordId, task, result, now });

    let discarded = false;
    let reused = false;
    let effectiveRecordId = recordId;
    try {
      this.deps.db.transaction(() => {
        const fresh = this.tasks.getById(task.id);
        if (fresh === null || fresh.status !== 'running') {
          discarded = true; // 取消/失败先到：丢弃，不写 record、不改状态。
          return;
        }
        const stored = this.records.insertOrGetByInputHash(record);
        reused = !stored.created;
        effectiveRecordId = stored.record.id;
        const succeeded = markSucceeded(fresh, { now, resultRecordId: effectiveRecordId });
        const ok = this.tasks.transition({ taskId: task.id, expectedStatus: 'running', next: succeeded });
        if (!ok) throw stateConflict('原子成功写入时任务已非 running'); // 触发回滚。
      })();
    } catch {
      // 写入事务失败：task 仍 running（已回滚），置 failed(RESULT_WRITE_FAILED)。
      return this.markRunningFailed(task, 'RESULT_WRITE_FAILED', '成功结果写入失败');
    }
    if (discarded) {
      return { kind: 'discarded', task: this.tasks.getById(task.id)!, reason: 'not_running_after_return' };
    }
    return { kind: 'succeeded', task: this.tasks.getById(task.id)!, recordId: effectiveRecordId, reused };
  }

  /**
   * analyze 抛错终态处理。先重读：非 running（取消先到）→ 丢弃，绝不用 failed 覆盖 cancelled（§8.3）。
   * 仍 running → 映射安全错误码并 CAS 置 failed。
   */
  private finishWithError(task: AnalysisTask, error: unknown): RunOutcome {
    const fresh = this.tasks.getById(task.id);
    if (fresh === null || fresh.status !== 'running') {
      return { kind: 'discarded', task: fresh ?? task, reason: 'not_running_after_return' };
    }
    const { errorCode, message } = classifyAnalyzeError(error);
    return this.markRunningFailed(fresh, errorCode, message);
  }

  /** running→failed CAS。若并发已改动（非 running）则不覆盖，返回丢弃。 */
  private markRunningFailed(
    task: AnalysisTask,
    errorCode: AnalysisTaskErrorCode,
    message: string,
  ): RunOutcome {
    const fresh = this.tasks.getById(task.id);
    if (fresh === null || fresh.status !== 'running') {
      return { kind: 'discarded', task: fresh ?? task, reason: 'not_running_after_return' };
    }
    const failed = markFailed(fresh, { now: this.deps.now(), errorCode, errorMessage: message });
    this.tasks.transition({ taskId: task.id, expectedStatus: 'running', next: failed });
    return { kind: 'failed', task: this.tasks.getById(task.id)!, errorCode };
  }

  /**
   * §8.2 取消（严格顺序）：先事务性 CAS 落 cancelled（expected=queued|running），
   * 命中 running 再 abort 对应 AbortController。幂等：已 cancelled 原样返回；succeeded 拒绝取消。
   * abort 只影响本进程 inflight，迟到结果由 finishWithResult 的重读丢弃。
   */
  cancel(taskId: string): AnalysisTask {
    const current = this.tasks.getById(taskId);
    if (current === null) throw invalidTransition('missing', 'cancel');
    if (current.status === 'cancelled') return current;
    // cancelTask 内部拒绝 succeeded/其他终态；先算目标态（可能抛 stateConflict/invalidTransition）。
    const cancelled = cancelTask(current, { now: this.deps.now() });
    const ok = this.tasks.transition({ taskId, expectedStatus: current.status, next: cancelled });
    if (!ok) {
      const after = this.tasks.getById(taskId)!;
      if (after.status === 'cancelled') return after;
      throw stateConflict('取消时任务状态已被并发改动');
    }
    if (current.status === 'running') this.inflight.get(taskId)?.abort();
    return cancelled;
  }

  /**
   * §10 进程恢复：**仅调用方在 capability 开启时**执行。
   * running → failed(PROCESS_RESTART_INTERRUPTED)；queued 原样保留交回执行队列（attempt 不变）。
   * 幂等：重复运行只影响仍 queued/running 的行。返回被中断与待重排的任务 ID。
   */
  recoverOnStartup(): { interrupted: string[]; requeued: string[] } {
    const interrupted: string[] = [];
    const requeued: string[] = [];
    for (const task of this.tasks.listRecoverable()) {
      if (task.status === 'running') {
        const failed = interruptRunningTask(task, { now: this.deps.now() });
        if (this.tasks.transition({ taskId: task.id, expectedStatus: 'running', next: failed })) {
          interrupted.push(task.id);
        }
      } else if (task.status === 'queued') {
        requeued.push(task.id);
      }
    }
    return { interrupted, requeued };
  }
}
