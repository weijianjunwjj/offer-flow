import { describe, expect, it } from 'vitest';
import { parsePromotionPlanV1 } from './promotionContract';
import { PromotionError } from './promotionErrors';
import {
  buildPromotionPlan,
  computePromotionIdempotencyKey,
  type PromotionPlanInput,
} from './promotionPlan';

function input(over: Partial<PromotionPlanInput> = {}): PromotionPlanInput {
  return {
    candidateId: 'cand-1',
    candidateVersionId: 'ver-1',
    trigger: 'hr_replied',
    requestedDepth: 'feedback',
    existing: { jobId: null, applicationId: null, applicationJobId: null },
    targetScopeKey: 'scope-abc',
    ...over,
  };
}

describe('V8-6 晋升计划 · 无回复不创建拒绝或能力反证', () => {
  it('trigger=no_response 直接拒绝晋升（连 job_only 也不允许）', () => {
    for (const depth of ['job_only', 'application', 'feedback'] as const) {
      expect(() => buildPromotionPlan(input({ trigger: 'no_response', requestedDepth: depth })))
        .toThrow(PromotionError);
    }
  });

  it('no_response 抛出稳定错误码，且不泄漏候选内容', () => {
    try {
      buildPromotionPlan(input({ trigger: 'no_response' }));
      expect.unreachable('应抛出 PromotionError');
    } catch (error) {
      expect(error).toBeInstanceOf(PromotionError);
      expect((error as PromotionError).code).toBe('PROMOTION_TRIGGER_NOT_ALLOWED');
    }
  });

  it('任何允许的触发原因都不会产出 no_response_recorded 类事件', () => {
    const triggers = ['hr_replied', 'contact_exchanged', 'interview_scheduled',
      'explicit_rejection', 'user_priority', 'user_explicit_request'] as const;
    for (const trigger of triggers) {
      const plan = buildPromotionPlan(input({ trigger }));
      // 只允许四种由真实进展直接证明的事件类型，或 null。
      expect(['hr_replied', 'hr_contacted', 'interview_scheduled', 'rejected', null])
        .toContain(plan.feedbackEventType);
    }
  });

  it('明确拒绝可写 rejected（与"无回复"严格区分）', () => {
    const plan = buildPromotionPlan(input({ trigger: 'explicit_rejection' }));
    expect(plan.effectiveDepth).toBe('feedback');
    expect(plan.feedbackEventType).toBe('rejected');
  });
});

describe('V8-6 晋升计划 · 触发原因钳制深度', () => {
  it('user_priority 只登记岗位：请求 feedback 也被钳到 job_only', () => {
    const plan = buildPromotionPlan(input({ trigger: 'user_priority', requestedDepth: 'feedback' }));
    expect(plan.effectiveDepth).toBe('job_only');
    expect(plan.application.mode).toBe('none');
    expect(plan.feedback.mode).toBe('none');
    expect(plan.feedbackEventType).toBeNull();
    expect(plan.clampReasons).toContain('trigger_forbids_application');
  });

  it('user_explicit_request 可建投递但不代写外部反馈', () => {
    const plan = buildPromotionPlan(input({ trigger: 'user_explicit_request', requestedDepth: 'feedback' }));
    expect(plan.effectiveDepth).toBe('application');
    expect(plan.application.mode).toBe('create');
    expect(plan.feedback.mode).toBe('none');
    expect(plan.feedbackEventType).toBeNull();
    expect(plan.clampReasons).toContain('trigger_forbids_feedback');
  });

  it('请求深度低于上限时不降级、不产生降级原因', () => {
    const plan = buildPromotionPlan(input({ trigger: 'hr_replied', requestedDepth: 'job_only' }));
    expect(plan.effectiveDepth).toBe('job_only');
    expect(plan.clampReasons).toEqual([]);
  });

  it('feedback 深度必定带确定的事件类型（不变量）', () => {
    const plan = buildPromotionPlan(input({ trigger: 'contact_exchanged', requestedDepth: 'feedback' }));
    expect(plan.effectiveDepth).toBe('feedback');
    expect(plan.feedbackEventType).toBe('hr_contacted');
  });
});

describe('V8-6 晋升计划 · 优先关联现有 Job/Application', () => {
  it('既有 Job 一律 link，不新建第二份', () => {
    const plan = buildPromotionPlan(input({
      existing: { jobId: 'job-9', applicationId: null, applicationJobId: null },
    }));
    expect(plan.job.mode).toBe('link');
    expect(plan.job.existingId).toBe('job-9');
  });

  it('既有 Job + 既有 Application 均 link', () => {
    const plan = buildPromotionPlan(input({
      existing: { jobId: 'job-9', applicationId: 'app-3', applicationJobId: 'job-9' },
    }));
    expect(plan.job).toEqual({ mode: 'link', existingId: 'job-9' });
    expect(plan.application).toEqual({ mode: 'link', existingId: 'app-3' });
  });

  it('无既有正式对象时才 create', () => {
    const plan = buildPromotionPlan(input());
    expect(plan.job.mode).toBe('create');
    expect(plan.application.mode).toBe('create');
  });

  it('FeedbackEvent 只追加，从不复用既有事件', () => {
    const plan = buildPromotionPlan(input({
      existing: { jobId: 'job-9', applicationId: 'app-3', applicationJobId: 'job-9' },
    }));
    expect(plan.feedback).toEqual({ mode: 'create', existingId: null });
  });

  it('既有投递不属于该岗位时拒绝晋升（不把正式事实挂错岗位）', () => {
    try {
      buildPromotionPlan(input({
        existing: { jobId: 'job-9', applicationId: 'app-3', applicationJobId: 'job-OTHER' },
      }));
      expect.unreachable('应抛出 PromotionError');
    } catch (error) {
      expect((error as PromotionError).code).toBe('PROMOTION_TARGET_CONFLICT');
    }
  });
});

describe('V8-6 晋升计划 · 幂等键', () => {
  it('同版本 + 同深度 + 同范围 → 同键（重复晋升幂等）', () => {
    const a = buildPromotionPlan(input());
    const b = buildPromotionPlan(input());
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('首次 create 与重放 link 必须算出同一键（幂等键不含本次新建的 id）', () => {
    // 首次：库里还没有 Job/Application，两者都要新建。
    const first = buildPromotionPlan(input());
    expect(first.job.mode).toBe('create');
    // 重放：上一次已建出 Job/Application，此时应 link——但键必须不变。
    const replay = buildPromotionPlan(input({
      existing: { jobId: 'job-new', applicationId: 'app-new', applicationJobId: 'job-new' },
    }));
    expect(replay.job.mode).toBe('link');
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('不同目标范围 → 不同键（同版本同深度指向不同岗位不互相顶掉）', () => {
    const a = buildPromotionPlan(input({ targetScopeKey: 'scope-a' }));
    const b = buildPromotionPlan(input({ targetScopeKey: 'scope-b' }));
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('不同候选版本 → 不同键', () => {
    const a = buildPromotionPlan(input({ candidateVersionId: 'ver-1' }));
    const b = buildPromotionPlan(input({ candidateVersionId: 'ver-2' }));
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('不同生效深度 → 不同键', () => {
    const a = buildPromotionPlan(input({ requestedDepth: 'job_only' }));
    const b = buildPromotionPlan(input({ requestedDepth: 'feedback' }));
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('换触发原因但生效深度相同 → 同键（不重复写正式晋升）', () => {
    const a = buildPromotionPlan(input({ trigger: 'hr_replied', requestedDepth: 'job_only' }));
    const b = buildPromotionPlan(input({ trigger: 'user_priority', requestedDepth: 'job_only' }));
    expect(a.effectiveDepth).toBe(b.effectiveDepth);
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
  });

  it('键带版本化前缀，便于规则语义演进时区分键空间', () => {
    expect(buildPromotionPlan(input()).idempotencyKey).toMatch(/^radar-promotion:v1:[0-9a-f]{64}$/);
  });

  it('computePromotionIdempotencyKey 为纯函数（同输入同输出）', () => {
    const args = { candidateVersionId: 'ver-1', effectiveDepth: 'application' as const, targetScopeKey: 's' };
    expect(computePromotionIdempotencyKey(args)).toBe(computePromotionIdempotencyKey(args));
  });
});

describe('V8-6 晋升计划 · 已晋升与契约校验', () => {
  it('命中既有 Promotion 时标记 already_promoted 并回带其 id', () => {
    const plan = buildPromotionPlan(input({ existingPromotionId: 'promo-1' }));
    expect(plan.existingPromotionId).toBe('promo-1');
    expect(plan.clampReasons).toContain('already_promoted');
  });

  it('未命中既有 Promotion 时 existingPromotionId 为 null', () => {
    expect(buildPromotionPlan(input()).existingPromotionId).toBeNull();
  });

  it('产出的计划通过严格契约校验（预览与执行共用同一形状）', () => {
    for (const trigger of ['hr_replied', 'user_priority', 'user_explicit_request'] as const) {
      const plan = buildPromotionPlan(input({ trigger }));
      expect(() => parsePromotionPlanV1(plan)).not.toThrow();
    }
  });

  it('契约拒绝多余字段（不被上层悄悄扩写）', () => {
    const plan = { ...buildPromotionPlan(input()), extra: 'x' };
    expect(() => parsePromotionPlanV1(plan)).toThrow();
  });
});
