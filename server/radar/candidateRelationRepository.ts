import type { RadarCandidateRelation, RadarCandidateRelationStatus } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarCandidateRelationToParams,
  rowToRadarCandidateRelation,
  type RadarCandidateRelationRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id_low, candidate_id_high, status, reason_code, signals_json,
  first_detected_at, last_detected_at, resolved_at, resolution_action_id,
  superseded_by_relation_id, created_at, updated_at
`;

/** 候选对稳定排序：始终返回 [low, high]，(A,B) 与 (B,A) 归一。 */
export function normalizeCandidatePair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/**
 * 候选关系读写（V8-3 疑似重复 / 人工裁决）。
 * 当前关系状态存本表（UNIQUE(low, high) 保证每对候选唯一有效关系）；
 * 每次裁决/撤销/重判的追加式事件由 RadarActionRepository 记录，二者分离、历史不丢。
 */
export class RadarCandidateRelationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(relation: RadarCandidateRelation): void {
    this.db.prepare(`
      INSERT INTO radar_candidate_relations (
        id, candidate_id_low, candidate_id_high, status, reason_code, signals_json,
        first_detected_at, last_detected_at, resolved_at, resolution_action_id,
        superseded_by_relation_id, created_at, updated_at
      ) VALUES (
        @id, @candidateIdLow, @candidateIdHigh, @status, @reasonCode, @signalsJson,
        @firstDetectedAt, @lastDetectedAt, @resolvedAt, @resolutionActionId,
        @supersededByRelationId, @createdAt, @updatedAt
      )
    `).run(radarCandidateRelationToParams(relation));
  }

  getById(id: string): RadarCandidateRelation | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_candidate_relations WHERE id = ?`)
      .get(id) as RadarCandidateRelationRow | undefined;
    return row === undefined ? null : rowToRadarCandidateRelation(row);
  }

  /** 按候选对（归一后）查当前有效关系。返回 none(null) / one。 */
  findByPair(candidateA: string, candidateB: string): RadarCandidateRelation | null {
    const { low, high } = normalizeCandidatePair(candidateA, candidateB);
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_candidate_relations WHERE candidate_id_low = ? AND candidate_id_high = ?`)
      .get(low, high) as RadarCandidateRelationRow | undefined;
    return row === undefined ? null : rowToRadarCandidateRelation(row);
  }

  /** 列出涉及某候选的全部关系（供待确认队列/展示）。 */
  listByCandidate(candidateId: string): RadarCandidateRelation[] {
    const rows = this.db
      .prepare(`
        SELECT ${COLUMNS} FROM radar_candidate_relations
        WHERE candidate_id_low = ? OR candidate_id_high = ?
        ORDER BY last_detected_at DESC, id
      `)
      .all(candidateId, candidateId) as RadarCandidateRelationRow[];
    return rows.map(rowToRadarCandidateRelation);
  }

  /** 列出某状态的全部关系（如待确认队列 suspected_duplicate / needs_recheck）。 */
  listByStatus(status: RadarCandidateRelationStatus): RadarCandidateRelation[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_candidate_relations WHERE status = ? ORDER BY last_detected_at DESC, id`)
      .all(status) as RadarCandidateRelationRow[];
    return rows.map(rowToRadarCandidateRelation);
  }

  /**
   * 更新关系状态（人工裁决落地）。resolvedAt/resolutionActionId 记录裁决事件，
   * updatedAt 单调递增。绝不删除旧关系；历史裁决由 RadarAction 追加保存。
   */
  updateStatus(
    id: string,
    status: RadarCandidateRelationStatus,
    resolvedAt: number | null,
    resolutionActionId: string | null,
    updatedAt: number,
    reasonCode: string | null,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE radar_candidate_relations
      SET status = @status, resolved_at = @resolvedAt, resolution_action_id = @resolutionActionId,
          reason_code = @reasonCode, updated_at = @updatedAt
      WHERE id = @id
    `).run({ id, status, resolvedAt, resolutionActionId, reasonCode, updatedAt });
    return result.changes === 1;
  }

  /** 刷新最近检测时间（同一批信号再次出现时，不改状态）。 */
  touchDetected(id: string, lastDetectedAt: number, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE radar_candidate_relations SET last_detected_at = @lastDetectedAt, updated_at = @updatedAt WHERE id = @id
    `).run({ id, lastDetectedAt, updatedAt });
    return result.changes === 1;
  }
}
