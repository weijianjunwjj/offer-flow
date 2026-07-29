import type { AnalysisTask, AnalysisTaskStatus } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import { inputConflict } from './analysis/errors';
import {
  analysisTaskToParams,
  rowToAnalysisTask,
  type AnalysisTaskRow,
} from './rowMappers';

const COLUMNS = `
  id, task_type, entity_type, entity_id, status, input_hash, input_snapshot_json,
  attempt_count, max_attempts, started_at, finished_at, cancelled_at,
  error_code, error_message, result_record_id, created_at, updated_at
`;

/** 恢复扫描（设计 §10）只关心尚未落终态的任务。 */
const RECOVERABLE_STATUSES: readonly AnalysisTaskStatus[] = ['queued', 'running'];

/** 稳定序列化：对象 key 递归字典序，用于比较两个 inputSnapshot 是否字节等价。 */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** insertOrGet 结果：created 区分「本次新建」与「命中已存在」。 */
export interface InsertOrGetResult {
  task: AnalysisTask;
  created: boolean;
}

/** transition（CAS）入参：WHERE 用 taskId + expectedStatus(+expectedAttemptCount) 守卫。 */
export interface TransitionParams {
  taskId: string;
  expectedStatus: AnalysisTaskStatus;
  expectedAttemptCount?: number;
  next: AnalysisTask;
}

/**
 * AnalysisTask 基础读写 + V8-4 任务领域原语。
 *
 * 幂等由**确定性主键**（analysis-task:v1:<inputHash>，由调用方传入）承载，不依赖进程内 Map：
 * insertOrGet 主键冲突时重读已存在任务，并校验 inputHash/inputSnapshot 一致，
 * 不一致抛 TASK_INPUT_CONFLICT，绝不静默复用。
 *
 * 业务状态迁移必须走 transition（CAS）：UPDATE 在 WHERE 中校验当前状态（及可选执行次数），
 * changes===1 才算成功，避免旧执行器覆盖已 cancelled 或 retry 后的新状态。
 * 状态更新 SQL 只写可变列，绝不改 task_type/entity_type/entity_id/input_hash/
 * input_snapshot_json/max_attempts/created_at。
 */
export class AnalysisTaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(task: AnalysisTask): void {
    this.db.prepare(`
      INSERT INTO analysis_tasks (
        id, task_type, entity_type, entity_id, status, input_hash, input_snapshot_json,
        attempt_count, max_attempts, started_at, finished_at, cancelled_at,
        error_code, error_message, result_record_id, created_at, updated_at
      ) VALUES (
        @id, @taskType, @entityType, @entityId, @status, @inputHash, @inputSnapshotJson,
        @attemptCount, @maxAttempts, @startedAt, @finishedAt, @cancelledAt,
        @errorCode, @errorMessage, @resultRecordId, @createdAt, @updatedAt
      )
    `).run(analysisTaskToParams(task));
  }

  getById(id: string): AnalysisTask | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM analysis_tasks WHERE id = ?`)
      .get(id) as AnalysisTaskRow | undefined;
    return row === undefined ? null : rowToAnalysisTask(row);
  }

  listByEntity(entityType: string, entityId: string): AnalysisTask[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM analysis_tasks WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC`)
      .all(entityType, entityId) as AnalysisTaskRow[];
    return rows.map(rowToAnalysisTask);
  }

  listByStatus(status: AnalysisTask['status']): AnalysisTask[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM analysis_tasks WHERE status = ? ORDER BY created_at`)
      .all(status) as AnalysisTaskRow[];
    return rows.map(rowToAnalysisTask);
  }

  /**
   * 按 inputHash 查任务。确定性主键下同一 inputHash 至多一行；
   * 返回最早创建的一行（历史遗留极端情况的稳定选择），无则 null。
   */
  findByInputHash(inputHash: string): AnalysisTask | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM analysis_tasks WHERE input_hash = ? ORDER BY created_at, id LIMIT 1`)
      .get(inputHash) as AnalysisTaskRow | undefined;
    return row === undefined ? null : rowToAnalysisTask(row);
  }

  /** 恢复扫描候选：仅 queued / running；succeeded/failed/cancelled 不返回。 */
  listRecoverable(): AnalysisTask[] {
    const placeholders = RECOVERABLE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM analysis_tasks WHERE status IN (${placeholders}) ORDER BY created_at, id`)
      .all(...RECOVERABLE_STATUSES) as AnalysisTaskRow[];
    return rows.map(rowToAnalysisTask);
  }

  /**
   * 确定性幂等创建。task.id 必须由调用方按 analysis-task:v1:<inputHash> 传入。
   * - 插入成功 → { created: true }；
   * - 主键冲突 → 重读同 ID 行；inputHash/inputSnapshot 一致返回 { created: false }，
   *   不一致抛 TASK_INPUT_CONFLICT（不静默复用）。
   * 不依赖进程内状态，两个并发相同输入的请求最终收敛到同一行。
   */
  insertOrGet(task: AnalysisTask): InsertOrGetResult {
    try {
      this.db.prepare(`
        INSERT INTO analysis_tasks (
          id, task_type, entity_type, entity_id, status, input_hash, input_snapshot_json,
          attempt_count, max_attempts, started_at, finished_at, cancelled_at,
          error_code, error_message, result_record_id, created_at, updated_at
        ) VALUES (
          @id, @taskType, @entityType, @entityId, @status, @inputHash, @inputSnapshotJson,
          @attemptCount, @maxAttempts, @startedAt, @finishedAt, @cancelledAt,
          @errorCode, @errorMessage, @resultRecordId, @createdAt, @updatedAt
        )
      `).run(analysisTaskToParams(task));
      return { task, created: true };
    } catch (error) {
      const existing = this.getById(task.id);
      // 只有「已存在同 ID 行」才是幂等重放路径；否则是真实写入错误，原样抛出。
      if (existing === null) throw error;
      if (
        existing.inputHash !== task.inputHash
        || canonicalize(existing.inputSnapshot) !== canonicalize(task.inputSnapshot)
      ) {
        throw inputConflict();
      }
      return { task: existing, created: false };
    }
  }

  /**
   * 条件状态迁移（CAS）。WHERE 校验当前状态（及可选执行次数），仅当唯一匹配时更新。
   * next 是状态机算出的完整目标任务；只写可变列，不动不可变列。
   * 返回是否成功更新（changes===1）；false 表示前置状态/次数已被他人改动。
   */
  transition(params: TransitionParams): boolean {
    const values = analysisTaskToParams(params.next);
    const where: string[] = ['id = @id', 'status = @expectedStatus'];
    const bind: Record<string, unknown> = {
      ...values,
      expectedStatus: params.expectedStatus,
    };
    if (params.expectedAttemptCount !== undefined) {
      where.push('attempt_count = @expectedAttemptCount');
      bind.expectedAttemptCount = params.expectedAttemptCount;
    }
    // max_attempts 属可变列：人工「重新分析」越过自动预算时会抬升它（见 taskStateMachine.manualRetryTask）。
    // 其余转移里 next.maxAttempts 原样透传，写入即无变化，语义安全。仍不写 task_type/entity_*/input_* 等不可变列。
    const result = this.db.prepare(`
      UPDATE analysis_tasks
      SET status = @status, attempt_count = @attemptCount, max_attempts = @maxAttempts, started_at = @startedAt,
          finished_at = @finishedAt, cancelled_at = @cancelledAt, error_code = @errorCode,
          error_message = @errorMessage, result_record_id = @resultRecordId, updated_at = @updatedAt
      WHERE ${where.join(' AND ')}
    `).run(bind);
    return result.changes === 1;
  }

  /**
   * @deprecated 低层无条件更新原语，保留供既有基础读写测试使用。
   * 业务状态机入口一律走 transition（CAS）；此方法不校验当前状态，勿用于状态迁移。
   */
  updateStatus(task: AnalysisTask): boolean {
    const params = analysisTaskToParams(task);
    const result = this.db.prepare(`
      UPDATE analysis_tasks
      SET status = @status, attempt_count = @attemptCount, started_at = @startedAt,
          finished_at = @finishedAt, cancelled_at = @cancelledAt, error_code = @errorCode,
          error_message = @errorMessage, result_record_id = @resultRecordId, updated_at = @updatedAt
      WHERE id = @id
    `).run(params);
    return result.changes === 1;
  }
}
