/**
 * RC-11 反向追踪服务（第一波，纯只读领域逻辑）。
 *
 * 双向可追溯性的"反向"一侧：从正式事实回溯 Radar 来源。所有关联均来自已存储的外键/字段，
 * 缺失即给明确状态（见 promotionTraceContract），绝不伪造。撤销 RadarAction 为 append-only 且
 * 受 FK RESTRICT 保护，不会删除或篡改正式事实链路——追踪对已撤销触发动作照常解析并如实标注 reverted。
 */
import type { SqliteDatabase } from '../../db';
import type { RadarPromotion } from '../../../src/domain/radar';
import { RadarPromotionRepository } from '../promotionRepository';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarActionRepository } from '../actionRepository';
import { RadarRecommendationBatchRepository } from '../recommendationBatchRepository';
import type {
  CandidateVersionTrace,
  FormalObjectKind,
  FormalObjectTrace,
  PromotionOriginTrace,
  RecommendationBatchTrace,
  TriggerTrace,
} from './promotionTraceContract';

export class PromotionTraceService {
  private readonly promotions: RadarPromotionRepository;
  private readonly candidates: RadarCandidateRepository;
  private readonly actions: RadarActionRepository;
  private readonly batches: RadarRecommendationBatchRepository;

  constructor(db: SqliteDatabase) {
    this.promotions = new RadarPromotionRepository(db);
    this.candidates = new RadarCandidateRepository(db);
    this.actions = new RadarActionRepository(db);
    this.batches = new RadarRecommendationBatchRepository(db);
  }

  /** 从 Promotion id 追溯来源；不存在则 null（HTTP 层转 404）。 */
  traceByPromotionId(promotionId: string): PromotionOriginTrace | null {
    const promotion = this.promotions.getById(promotionId);
    return promotion === null ? null : this.buildOriginTrace(promotion);
  }

  traceByJob(jobId: string): FormalObjectTrace {
    return this.buildFormalTrace('job', jobId, this.promotions.findByJobId(jobId));
  }

  traceByApplication(applicationId: string): FormalObjectTrace {
    return this.buildFormalTrace('application', applicationId, this.promotions.findByApplicationId(applicationId));
  }

  traceByFeedbackEvent(feedbackEventId: string): FormalObjectTrace {
    return this.buildFormalTrace('feedback_event', feedbackEventId, this.promotions.findByFeedbackEventId(feedbackEventId));
  }

  /** 正式对象 → 来源：无引用晋升即明确不可追溯，绝不编造。 */
  private buildFormalTrace(
    objectKind: FormalObjectKind,
    objectId: string,
    promotions: RadarPromotion[],
  ): FormalObjectTrace {
    if (promotions.length === 0) {
      return { objectKind, objectId, traceable: false, reason: 'no_promotion' };
    }
    return { objectKind, objectId, traceable: true, promotions: promotions.map((p) => this.buildOriginTrace(p)) };
  }

  private buildOriginTrace(promotion: RadarPromotion): PromotionOriginTrace {
    return {
      promotionId: promotion.id,
      promotionType: promotion.promotionType,
      candidateId: promotion.candidateId,
      jobId: promotion.jobId,
      applicationId: promotion.applicationId,
      feedbackEventId: promotion.feedbackEventId,
      createdAt: promotion.createdAt,
      candidateVersion: this.resolveCandidateVersion(promotion.candidateVersionId),
      trigger: this.resolveTrigger(promotion.triggerActionId),
      recommendationBatches: this.resolveBatches(promotion.candidateVersionId),
    };
  }

  private resolveCandidateVersion(candidateVersionId: string): CandidateVersionTrace {
    const version = this.candidates.getVersion(candidateVersionId);
    if (version === null) return { status: 'missing', candidateVersionId };
    return {
      status: 'resolved',
      candidateId: version.candidateId,
      candidateVersionId: version.id,
      versionNo: version.versionNo,
      contentHash: version.contentHash,
      originType: version.originType,
      sourceSnapshotIds: version.sourceSnapshotIds,
      createdAt: version.createdAt,
    };
  }

  /** 触发原因只存 trigger_action_id：null → not_recorded；行丢失 → action_missing；否则解析并标注 reverted。 */
  private resolveTrigger(triggerActionId: string | null): TriggerTrace {
    if (triggerActionId === null) return { status: 'not_recorded' };
    const action = this.actions.getById(triggerActionId);
    if (action === null) return { status: 'action_missing', triggerActionId };
    return {
      status: 'resolved',
      actionId: action.id,
      actionType: action.actionType,
      reasonCode: action.reasonCode,
      reasonText: action.reasonText,
      occurredAt: action.occurredAt,
      reverted: action.revertedByActionId !== null,
      revertedByActionId: action.revertedByActionId,
    };
  }

  /** 推荐批次：按 scope 成员关系推断（非因果外键），显式标注 linked_by_scope_membership。 */
  private resolveBatches(candidateVersionId: string): RecommendationBatchTrace {
    const batches = this.batches.listByCandidateVersionMembership(candidateVersionId);
    if (batches.length === 0) return { status: 'no_batch' };
    return {
      status: 'linked_by_scope_membership',
      batches: batches.map((b) => ({
        batchId: b.id,
        batchKey: b.batchKey,
        status: b.status,
        diagnosisStatus: b.diagnosisStatus,
        emptyReason: b.emptyReason,
        generatedAt: b.generatedAt,
        wasSelected: b.selectedCandidateVersionIds.includes(candidateVersionId),
      })),
    };
  }
}
