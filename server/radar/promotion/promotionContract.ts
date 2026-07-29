/**
 * V8-6 第一波 · 正式晋升领域契约 `PromotionPlanV1`。
 *
 * 本波次只定义契约 + 确定性计划推导 + 幂等键，不接 HTTP、不接前端、
 * 不落 migration（`radar_promotions` 表与 Repository 已由 V8-1 schema v7 提供）。
 *
 * 硬边界（对齐 PRD P0-11 / US-09、TD §11.7 / §13.4）：
 * - 优先关联现有 Job/Application，不盲目新建；
 * - 重复晋升幂等（idempotency_key 至少含 candidateVersionId + promotionType + 目标正式对象范围）；
 * - 无回复不创建拒绝或能力反证（硬否定规则，见 promotionPlan.ts）；
 * - 晋升前必须重新读取正式对象（服务层职责，第二波实现）；
 * - 撤销雷达动作不删除正式事实（Promotion 与 Action 生命周期解耦）。
 */
import { z } from 'zod';
import { RADAR_PROMOTION_TYPES, type RadarPromotionType } from '../../../src/domain/radar';

export const PROMOTION_CONTRACT_VERSION = 1;

/**
 * 晋升触发原因：只有"真实外部进展"或"用户明确要求"可触发（US-09）。
 * 这不是 RadarActionType 的别名——RadarAction 记录交互留痕，
 * 本枚举描述"为什么现在可以安全写正式事实"。
 */
export const PROMOTION_TRIGGERS = [
  'hr_replied',
  'contact_exchanged',
  'interview_scheduled',
  'explicit_rejection',
  'user_priority',
  'user_explicit_request',
  'no_response',
] as const;
export type PromotionTrigger = (typeof PROMOTION_TRIGGERS)[number];

/**
 * 晋升深度 = 数据库 promotion_type（job_only < application < feedback）。
 * 深度决定要写入哪些正式对象，由触发原因确定性地设上限（见 promotionPlan.ts）。
 */
export const PROMOTION_DEPTHS = RADAR_PROMOTION_TYPES;
export type PromotionDepth = RadarPromotionType;

/** 深度序：用于把"请求深度"钳制到"触发原因允许的最大深度"。 */
export const PROMOTION_DEPTH_ORDER: Record<PromotionDepth, number> = {
  job_only: 0,
  application: 1,
  feedback: 2,
};

/** 正式对象的关联方式：link=复用已存在的正式对象；create=本次新建。 */
export const PROMOTION_LINK_MODES = ['link', 'create', 'none'] as const;
export type PromotionLinkMode = (typeof PROMOTION_LINK_MODES)[number];

/**
 * FeedbackEvent 事件类型（feedback_events.event_type 的子集）。
 * 只允许晋升写入"由真实外部进展直接证明"的事件；
 * 尤其不含 no_response_recorded 与任何能力反证类事件。
 */
export const PROMOTION_FEEDBACK_EVENT_TYPES = [
  'hr_replied',
  'hr_contacted',
  'interview_scheduled',
  'rejected',
] as const;
export type PromotionFeedbackEventType = (typeof PROMOTION_FEEDBACK_EVENT_TYPES)[number];

/** 计划被降级/拒绝的确定性原因码（预览必须能解释"为什么没做到请求的深度"）。 */
export const PROMOTION_CLAMP_REASONS = [
  'trigger_forbids_feedback',
  'trigger_forbids_application',
  'no_response_no_negative_fact',
  'already_promoted',
] as const;
export type PromotionClampReason = (typeof PROMOTION_CLAMP_REASONS)[number];

/** 单个正式对象的处置计划：link 复用既有 id，create 新建，none 不涉及。 */
export interface PromotionTargetPlan {
  mode: PromotionLinkMode;
  /** link 模式下为既有正式对象 id；create/none 为 null（新 id 由写入阶段生成）。 */
  existingId: string | null;
}

/**
 * 晋升计划（预览与执行共用同一份确定性结果）。
 * 预览 = 只返回本对象；执行 = 按本对象在单事务内写入并落 RadarPromotion。
 */
export interface PromotionPlanV1 {
  contractVersion: typeof PROMOTION_CONTRACT_VERSION;
  candidateId: string;
  candidateVersionId: string;
  trigger: PromotionTrigger;
  /** 调用方请求的深度（未钳制）。 */
  requestedDepth: PromotionDepth;
  /** 实际可执行深度（已按触发原因钳制）。 */
  effectiveDepth: PromotionDepth;
  job: PromotionTargetPlan;
  application: PromotionTargetPlan;
  feedback: PromotionTargetPlan;
  /** effectiveDepth = feedback 时的事件类型；否则 null。 */
  feedbackEventType: PromotionFeedbackEventType | null;
  /** 深度被降级或整体已完成的原因（确定性、可解释；无降级时为空数组）。 */
  clampReasons: PromotionClampReason[];
  /** 幂等键：重复晋升命中同一行，不产生第二份正式对象。 */
  idempotencyKey: string;
  /** 命中既有 Promotion 时为该行 id：预览据此显示"已晋升"，执行据此直接返回。 */
  existingPromotionId: string | null;
}

const targetPlanSchema = z.object({
  mode: z.enum(PROMOTION_LINK_MODES),
  existingId: z.string().min(1).nullable(),
});

/** 严格契约校验：拒绝多余字段，保证计划形状不被上层悄悄扩写。 */
export const promotionPlanV1Schema = z.object({
  contractVersion: z.literal(PROMOTION_CONTRACT_VERSION),
  candidateId: z.string().min(1),
  candidateVersionId: z.string().min(1),
  trigger: z.enum(PROMOTION_TRIGGERS),
  requestedDepth: z.enum(PROMOTION_DEPTHS),
  effectiveDepth: z.enum(PROMOTION_DEPTHS),
  job: targetPlanSchema,
  application: targetPlanSchema,
  feedback: targetPlanSchema,
  feedbackEventType: z.enum(PROMOTION_FEEDBACK_EVENT_TYPES).nullable(),
  clampReasons: z.array(z.enum(PROMOTION_CLAMP_REASONS)),
  idempotencyKey: z.string().min(1),
  existingPromotionId: z.string().min(1).nullable(),
}).strict();

export function parsePromotionPlanV1(value: unknown): PromotionPlanV1 {
  return promotionPlanV1Schema.parse(value) as PromotionPlanV1;
}
