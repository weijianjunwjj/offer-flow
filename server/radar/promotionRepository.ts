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

  /**
   * 反向追踪（RC-11）：从正式对象反查引用它的晋升。
   * 返回数组而非单条——link 模式下同一 Job 可被多份晋升关联（P0-11），
   * 追踪必须如实呈现全部来源而非任取一条。按 created_at,id 确定性排序。
   */
  private findByColumn(column: 'job_id' | 'application_id' | 'feedback_event_id', value: string): RadarPromotion[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_promotions WHERE ${column} = ? ORDER BY created_at, id`)
      .all(value) as RadarPromotionRow[];
    return rows.map(rowToRadarPromotion);
  }

  findByJobId(jobId: string): RadarPromotion[] {
    return this.findByColumn('job_id', jobId);
  }

  findByApplicationId(applicationId: string): RadarPromotion[] {
    return this.findByColumn('application_id', applicationId);
  }

  findByFeedbackEventId(feedbackEventId: string): RadarPromotion[] {
    return this.findByColumn('feedback_event_id', feedbackEventId);
  }
}
