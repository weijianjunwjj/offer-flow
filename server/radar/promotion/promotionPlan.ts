/**
 * V8-6 第一波 · 晋升计划确定性推导（纯函数，无 IO）。
 *
 * 输入 = 候选版本身份 + 触发原因 + 请求深度 + 已重新读取的既有正式对象；
 * 输出 = `PromotionPlanV1`（预览与执行共用），含幂等键与降级原因。
 *
 * 三条不可妥协的规则：
 * 1. **无回复不创建拒绝或能力反证**：trigger=no_response 直接拒绝晋升，
 *    不写 job、不写 application、更不写 rejected 事件（US-09）。
 * 2. **优先关联现有 Job/Application**：调用方传入既有 id 时一律 link，绝不新建第二份。
 * 3. **幂等键只由输入身份决定**：不含"本次新建的 id"，
 *    否则首次 create 与重放 link 会算出不同键，幂等失效（TD §13.4）。
 */
import { sha256RequestHash } from '../../job-memory/requestHash';
import {
  PROMOTION_CONTRACT_VERSION,
  PROMOTION_DEPTH_ORDER,
  type PromotionClampReason,
  type PromotionDepth,
  type PromotionFeedbackEventType,
  type PromotionPlanV1,
  type PromotionTargetPlan,
  type PromotionTrigger,
} from './promotionContract';
import { targetConflict, triggerNotAllowed } from './promotionErrors';

/** 幂等键前缀：语义版本化，规则语义变化即产生不同键空间。 */
export const PROMOTION_IDEMPOTENCY_PREFIX = 'radar-promotion:v1';

/**
 * 每个触发原因允许的最大深度 + 对应的 FeedbackEvent 类型。
 * `maxDepth: null` = 该触发原因完全不允许晋升。
 */
const TRIGGER_POLICY: Record<PromotionTrigger, {
  maxDepth: PromotionDepth | null;
  feedbackEventType: PromotionFeedbackEventType | null;
}> = {
  // 外部真实进展：可写到 feedback 深度，事件类型由进展本身决定。
  hr_replied: { maxDepth: 'feedback', feedbackEventType: 'hr_replied' },
  contact_exchanged: { maxDepth: 'feedback', feedbackEventType: 'hr_contacted' },
  interview_scheduled: { maxDepth: 'feedback', feedbackEventType: 'interview_scheduled' },
  // 明确拒绝是真实外部事实，可写 rejected；与"无回复"严格区分。
  explicit_rejection: { maxDepth: 'feedback', feedbackEventType: 'rejected' },
  // 用户主动重点跟进：只登记岗位，不伪造投递或外部反馈。
  user_priority: { maxDepth: 'job_only', feedbackEventType: null },
  // 用户明确要求：可建 Application，但不代写外部反馈事件。
  user_explicit_request: { maxDepth: 'application', feedbackEventType: null },
  // 无回复不是事实：不允许任何晋升，尤其不得推导拒绝或能力反证。
  no_response: { maxDepth: null, feedbackEventType: null },
};

/** 已重新读取的既有正式对象（服务层在事务内查得后传入；TD §11.7"晋升前重新读取"）。 */
export interface ExistingFormalObjects {
  jobId: string | null;
  applicationId: string | null;
  /** 该 application 当前归属的 jobId：用于校验 application 与 job 一致。 */
  applicationJobId: string | null;
}

export interface PromotionPlanInput {
  candidateId: string;
  candidateVersionId: string;
  trigger: PromotionTrigger;
  requestedDepth: PromotionDepth;
  existing: ExistingFormalObjects;
  /**
   * 目标正式对象范围键：参与幂等键，保证"同版本同深度但指向不同 Job"不会互相顶掉。
   * 由服务层用候选版本的规范化身份（公司/岗位/城市）派生，稳定且与"新建还是关联"无关。
   */
  targetScopeKey: string;
  /** 已存在的 Promotion（按幂等键查得）：命中即幂等复用，不再写第二份。 */
  existingPromotionId?: string | null;
}

function clampDepth(requested: PromotionDepth, max: PromotionDepth): PromotionDepth {
  return PROMOTION_DEPTH_ORDER[requested] <= PROMOTION_DEPTH_ORDER[max] ? requested : max;
}

/**
 * 深度降级原因：区分"被禁止 application"与"被禁止 feedback"，供预览逐条解释。
 * 钳到 job_only ⇒ application 被禁；钳到 application ⇒ 仅 feedback 被禁。
 */
function clampReasonFor(requested: PromotionDepth, effective: PromotionDepth): PromotionClampReason | null {
  if (PROMOTION_DEPTH_ORDER[requested] <= PROMOTION_DEPTH_ORDER[effective]) return null;
  return effective === 'job_only' ? 'trigger_forbids_application' : 'trigger_forbids_feedback';
}

/**
 * 幂等键 = prefix + sha256(candidateVersionId + effectiveDepth + targetScopeKey)。
 *
 * 刻意**不含**触发原因与本次新建的对象 id：
 * - 不含新建 id：首次 create 与重放 link 必须算出同一键，否则幂等失效；
 * - 不含 trigger：同一版本同一深度同一目标只应有一份正式晋升，
 *   换个触发原因重放不应再写一份（深度差异已由 effectiveDepth 体现）。
 */
export function computePromotionIdempotencyKey(args: {
  candidateVersionId: string;
  effectiveDepth: PromotionDepth;
  targetScopeKey: string;
}): string {
  const digest = sha256RequestHash({
    candidateVersionId: args.candidateVersionId,
    effectiveDepth: args.effectiveDepth,
    targetScopeKey: args.targetScopeKey,
  });
  return `${PROMOTION_IDEMPOTENCY_PREFIX}:${digest}`;
}

function targetPlan(existingId: string | null, needed: boolean): PromotionTargetPlan {
  if (!needed) return { mode: 'none', existingId: null };
  // 优先关联现有正式对象（P0-11）：有既有 id 就 link，绝不新建第二份。
  return existingId === null ? { mode: 'create', existingId: null } : { mode: 'link', existingId };
}

/**
 * 推导晋升计划。纯函数：同一输入恒定得到同一计划与同一幂等键。
 *
 * @throws PromotionError PROMOTION_TRIGGER_NOT_ALLOWED（no_response）
 * @throws PromotionError PROMOTION_TARGET_CONFLICT（application 与 job 不一致）
 */
export function buildPromotionPlan(input: PromotionPlanInput): PromotionPlanV1 {
  const policy = TRIGGER_POLICY[input.trigger];
  // 硬否定规则：无回复不构成正式事实，连 job_only 都不允许。
  if (policy.maxDepth === null) throw triggerNotAllowed();

  const { existing } = input;
  // 一致性校验：传入的 application 必须属于传入的 job，否则会把正式事实挂错岗位。
  if (
    existing.applicationId !== null
    && existing.applicationJobId !== null
    && existing.jobId !== null
    && existing.applicationJobId !== existing.jobId
  ) {
    throw targetConflict('既有投递不属于该岗位，不能晋升');
  }

  // 不变量：feedback 深度必须有确定的事件类型。缺失则只能钳到 application，
  // 避免写出"promotion_type=feedback 但没有事件"的不一致正式事实。
  const maxDepth: PromotionDepth = policy.maxDepth === 'feedback' && policy.feedbackEventType === null
    ? 'application'
    : policy.maxDepth;

  const effectiveDepth = clampDepth(input.requestedDepth, maxDepth);
  const depth = PROMOTION_DEPTH_ORDER[effectiveDepth];

  const clampReasons: PromotionClampReason[] = [];
  const clamped = clampReasonFor(input.requestedDepth, effectiveDepth);
  if (clamped !== null) clampReasons.push(clamped);

  const existingPromotionId = input.existingPromotionId ?? null;
  if (existingPromotionId !== null) clampReasons.push('already_promoted');

  return {
    contractVersion: PROMOTION_CONTRACT_VERSION,
    candidateId: input.candidateId,
    candidateVersionId: input.candidateVersionId,
    trigger: input.trigger,
    requestedDepth: input.requestedDepth,
    effectiveDepth,
    // Job 始终参与（job_only 及以上都要有 Job）。
    job: targetPlan(existing.jobId, true),
    application: targetPlan(existing.applicationId, depth >= PROMOTION_DEPTH_ORDER.application),
    // FeedbackEvent 只追加，从不复用既有事件（append-only 事实流）。
    feedback: depth >= PROMOTION_DEPTH_ORDER.feedback
      ? { mode: 'create', existingId: null }
      : { mode: 'none', existingId: null },
    feedbackEventType: depth >= PROMOTION_DEPTH_ORDER.feedback ? policy.feedbackEventType : null,
    clampReasons,
    idempotencyKey: computePromotionIdempotencyKey({
      candidateVersionId: input.candidateVersionId,
      effectiveDepth,
      targetScopeKey: input.targetScopeKey,
    }),
    existingPromotionId,
  };
}
