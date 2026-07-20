import type { RadarAction } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarActionToParams,
  rowToRadarAction,
  type RadarActionRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id, candidate_version_id, action_type, reason_code, reason_text,
  metadata_json, occurred_at, reverted_by_action_id, created_at
`;

/**
 * Action 是纯事件日志追加写入（TD §4.11）：撤销一个行为记录新的 reverted 事件，
 * 并回填旧行为的 reverted_by_action_id，绝不物理删除或改写旧行为语义。
 */
export class RadarActionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(action: RadarAction): void {
    this.db.prepare(`
      INSERT INTO radar_actions (
        id, candidate_id, candidate_version_id, action_type, reason_code, reason_text,
        metadata_json, occurred_at, reverted_by_action_id, created_at
      ) VALUES (
        @id, @candidateId, @candidateVersionId, @actionType, @reasonCode, @reasonText,
        @metadataJson, @occurredAt, @revertedByActionId, @createdAt
      )
    `).run(radarActionToParams(action));
  }

  getById(id: string): RadarAction | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_actions WHERE id = ?`)
      .get(id) as RadarActionRow | undefined;
    return row === undefined ? null : rowToRadarAction(row);
  }

  listByCandidate(candidateId: string): RadarAction[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_actions WHERE candidate_id = ? ORDER BY occurred_at DESC, id DESC`)
      .all(candidateId) as RadarActionRow[];
    return rows.map(rowToRadarAction);
  }

  markReverted(id: string, revertedByActionId: string): boolean {
    const result = this.db.prepare(`
      UPDATE radar_actions SET reverted_by_action_id = @revertedByActionId
      WHERE id = @id AND reverted_by_action_id IS NULL
    `).run({ id, revertedByActionId });
    return result.changes === 1;
  }
}
