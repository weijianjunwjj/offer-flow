import type { RadarPromotion } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarPromotionToParams,
  rowToRadarPromotion,
  type RadarPromotionRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id, candidate_version_id, promotion_type, job_id, application_id,
  feedback_event_id, trigger_action_id, idempotency_key, created_at
`;

/**
 * Promotion 基础读写。idempotency_key 唯一约束保证"晋升两次不产生重复正式对象"（TD §11）。
 * 具体晋升业务流程（创建 Job/Application/FeedbackEvent 并写入本表）由 V8-6 服务层实现。
 */
export class RadarPromotionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(promotion: RadarPromotion): void {
    this.db.prepare(`
      INSERT INTO radar_promotions (
        id, candidate_id, candidate_version_id, promotion_type, job_id, application_id,
        feedback_event_id, trigger_action_id, idempotency_key, created_at
      ) VALUES (
        @id, @candidateId, @candidateVersionId, @promotionType, @jobId, @applicationId,
        @feedbackEventId, @triggerActionId, @idempotencyKey, @createdAt
      )
    `).run(radarPromotionToParams(promotion));
  }

  getById(id: string): RadarPromotion | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_promotions WHERE id = ?`)
      .get(id) as RadarPromotionRow | undefined;
    return row === undefined ? null : rowToRadarPromotion(row);
  }

  findByIdempotencyKey(idempotencyKey: string): RadarPromotion | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_promotions WHERE idempotency_key = ?`)
      .get(idempotencyKey) as RadarPromotionRow | undefined;
    return row === undefined ? null : rowToRadarPromotion(row);
  }

  listByCandidate(candidateId: string): RadarPromotion[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_promotions WHERE candidate_id = ? ORDER BY created_at, id`)
      .all(candidateId) as RadarPromotionRow[];
    return rows.map(rowToRadarPromotion);
  }
}
