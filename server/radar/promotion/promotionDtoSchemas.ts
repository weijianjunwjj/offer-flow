/**
 * V8-6 第二波 · 晋升 HTTP 边界严格 DTO 与安全出参视图。
 *
 * - 入参：触发原因 + 请求深度 + 可选的既有正式对象 id（strict 拒绝未知字段）；
 *   前端**不能**指定要写哪些表、不能指定 FeedbackEvent 类型——那些由计划确定性推导。
 * - 出参：晋升结果 + 计划快照。计划内只含语义字段与正式对象 id，
 *   不外泄 targetScopeKey / requestHash 等内部派生值；idempotencyKey 亦不透出。
 */
import { z } from 'zod';
import type { RadarPromotion } from '../../../src/domain/radar';
import {
  PROMOTION_DEPTHS,
  PROMOTION_TRIGGERS,
  type PromotionPlanV1,
} from './promotionContract';

const nonBlankId = z.string().trim().min(1).max(120);

/** 晋升请求：只描述"为什么晋升 + 想晋升到多深 + 已知的既有正式对象"。 */
export const PromoteRequestSchema = z.strictObject({
  trigger: z.enum(PROMOTION_TRIGGERS),
  requestedDepth: z.enum(PROMOTION_DEPTHS),
  /** 调用方已知的既有 Job/Application：传入即优先关联，不新建第二份（P0-11）。 */
  jobId: nonBlankId.nullish(),
  applicationId: nonBlankId.nullish(),
  /** 触发本次晋升的 RadarAction 留痕 id（审计用，可空）。 */
  triggerActionId: nonBlankId.nullish(),
});
export type PromoteRequest = z.infer<typeof PromoteRequestSchema>;

/** 计划安全视图：去掉 idempotencyKey 等内部键，只保留可解释语义。 */
export interface PromotionPlanView {
  candidateId: string;
  candidateVersionId: string;
  trigger: string;
  requestedDepth: string;
  effectiveDepth: string;
  jobMode: string;
  applicationMode: string;
  feedbackMode: string;
  feedbackEventType: string | null;
  clampReasons: string[];
  /** 已存在的晋升 id（幂等命中）；预览据此提示"已晋升过，确认不会再建一份"。 */
  existingPromotionId: string | null;
  /** 将被关联的既有正式对象 id：供预览逐条说明"关联哪一个"。 */
  linkedJobId: string | null;
  linkedApplicationId: string | null;
}

export interface PromotionView {
  id: string;
  candidateId: string;
  candidateVersionId: string;
  promotionType: string;
  jobId: string;
  applicationId: string | null;
  feedbackEventId: string | null;
  triggerActionId: string | null;
  createdAt: number;
}

export function toPromotionPlanView(plan: PromotionPlanV1): PromotionPlanView {
  return {
    candidateId: plan.candidateId,
    candidateVersionId: plan.candidateVersionId,
    trigger: plan.trigger,
    requestedDepth: plan.requestedDepth,
    effectiveDepth: plan.effectiveDepth,
    jobMode: plan.job.mode,
    applicationMode: plan.application.mode,
    feedbackMode: plan.feedback.mode,
    feedbackEventType: plan.feedbackEventType,
    clampReasons: [...plan.clampReasons],
    existingPromotionId: plan.existingPromotionId,
    // 只在 link 模式下透出目标 id：create 模式尚无对象，null 即"将新建"。
    linkedJobId: plan.job.mode === 'link' ? plan.job.existingId : null,
    linkedApplicationId: plan.application.mode === 'link' ? plan.application.existingId : null,
  };
}

export function toPromotionView(promotion: RadarPromotion): PromotionView {
  return {
    id: promotion.id,
    candidateId: promotion.candidateId,
    candidateVersionId: promotion.candidateVersionId,
    promotionType: promotion.promotionType,
    jobId: promotion.jobId,
    applicationId: promotion.applicationId,
    feedbackEventId: promotion.feedbackEventId,
    triggerActionId: promotion.triggerActionId,
    createdAt: promotion.createdAt,
  };
}
