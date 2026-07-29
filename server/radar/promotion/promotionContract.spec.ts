import { describe, expect, it } from 'vitest';
import { RADAR_PROMOTION_TYPES } from '../../../src/domain/radar';
import {
  PROMOTION_CONTRACT_VERSION,
  PROMOTION_DEPTHS,
  PROMOTION_DEPTH_ORDER,
  PROMOTION_FEEDBACK_EVENT_TYPES,
  parsePromotionPlanV1,
} from './promotionContract';

describe('V8-6 晋升契约', () => {
  it('深度枚举与数据库 promotion_type CHECK 完全一致', () => {
    expect([...PROMOTION_DEPTHS]).toEqual([...RADAR_PROMOTION_TYPES]);
    expect([...PROMOTION_DEPTHS]).toEqual(['job_only', 'application', 'feedback']);
  });

  it('深度序严格递增（钳制逻辑依赖此序）', () => {
    expect(PROMOTION_DEPTH_ORDER.job_only).toBeLessThan(PROMOTION_DEPTH_ORDER.application);
    expect(PROMOTION_DEPTH_ORDER.application).toBeLessThan(PROMOTION_DEPTH_ORDER.feedback);
  });

  it('允许写入的事件类型不含无回复与能力反证类事件', () => {
    const allowed: readonly string[] = PROMOTION_FEEDBACK_EVENT_TYPES;
    expect(allowed).not.toContain('no_response_recorded');
    expect(allowed).not.toContain('marked_stale');
    expect(allowed).toEqual(['hr_replied', 'hr_contacted', 'interview_scheduled', 'rejected']);
  });

  it('契约版本为 1', () => {
    expect(PROMOTION_CONTRACT_VERSION).toBe(1);
  });

  it('拒绝非法深度与非法事件类型', () => {
    const base = {
      contractVersion: 1, candidateId: 'c', candidateVersionId: 'v',
      trigger: 'hr_replied', requestedDepth: 'feedback', effectiveDepth: 'feedback',
      job: { mode: 'create', existingId: null },
      application: { mode: 'create', existingId: null },
      feedback: { mode: 'create', existingId: null },
      feedbackEventType: 'hr_replied', clampReasons: [],
      idempotencyKey: 'k', existingPromotionId: null,
    };
    expect(() => parsePromotionPlanV1(base)).not.toThrow();
    expect(() => parsePromotionPlanV1({ ...base, effectiveDepth: 'everything' })).toThrow();
    expect(() => parsePromotionPlanV1({ ...base, feedbackEventType: 'no_response_recorded' })).toThrow();
    expect(() => parsePromotionPlanV1({ ...base, trigger: 'vibes' })).toThrow();
  });
});
