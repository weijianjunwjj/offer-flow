import type { AnalysisTask } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
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

/**
 * AnalysisTask 基础读写。状态机（queued→running→succeeded/failed/cancelled）
 * 与进程重启恢复扫描（TD §10.3）由 V8-4 服务层实现；此处只提供存取原语。
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
