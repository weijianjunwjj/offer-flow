import { describe, expect, it } from 'vitest';
import {
  classifyEventForCapability,
  describeInsufficientGuidance,
  evidenceGuardrailViolations,
  externalConstraintKindForReason,
  isDuplicateEvidence,
  isExternalConstraintReason,
  isWeakMarketSignalEvent,
} from './policies';
import { makeCandidateEvidenceContentFixture } from './testFixtures';

describe('能力基线护栏策略', () => {
  it('单次 no_response 不构成能力反证，只是 neutral 弱信号', () => {
    const result = classifyEventForCapability('no_response_recorded', null);
    expect(result).toEqual({ kind: 'capability_signal', polarity: 'neutral', strengthCap: 'weak' });
  });

  it('message_viewed 不能单独构成强反证', () => {
    const result = classifyEventForCapability('message_viewed', null);
    expect(result.kind).toBe('capability_signal');
    if (result.kind === 'capability_signal') {
      expect(result.polarity).not.toBe('counter');
      expect(result.strengthCap).toBe('weak');
    }
    expect(isWeakMarketSignalEvent('message_viewed')).toBe(true);
  });

  it('recruitment_paused / recruitment_frozen 不等于能力不足', () => {
    for (const eventType of ['recruitment_paused', 'recruitment_frozen']) {
      const result = classifyEventForCapability(eventType, null);
      expect(result.kind).toBe('capability_signal');
      if (result.kind === 'capability_signal') expect(result.polarity).toBe('neutral');
    }
  });

  it('学历门槛拒绝归为外部门槛，不写入能力反证', () => {
    const result = classifyEventForCapability('rejected', 'education');
    expect(result).toEqual({ kind: 'external_constraint', constraintKind: 'education' });
    expect(isExternalConstraintReason('education')).toBe(true);
    expect(externalConstraintKindForReason('salary')).toBe('salary');
  });

  it('因能力/经验被拒是真实能力反证', () => {
    const skills = classifyEventForCapability('rejected', 'skills');
    expect(skills.kind).toBe('capability_signal');
    if (skills.kind === 'capability_signal') expect(skills.polarity).toBe('counter');
  });

  it('市场薪资拒绝不写入能力等级', () => {
    const result = classifyEventForCapability('rejected', 'salary');
    expect(result.kind).toBe('external_constraint');
  });

  it('短期反馈事件不得作为强反证：evidenceGuardrailViolations 命中', () => {
    const violations = evidenceGuardrailViolations(makeCandidateEvidenceContentFixture({
      polarity: 'counter', strength: 'strong', sourceType: 'feedback_event', sourceConfidence: 'recalled',
    }));
    expect(violations.length).toBeGreaterThan(0);
  });

  it('确证反馈事件的能力反证不违规', () => {
    const violations = evidenceGuardrailViolations(makeCandidateEvidenceContentFixture({
      polarity: 'counter', strength: 'medium', sourceType: 'feedback_event', sourceConfidence: 'exact',
    }));
    expect(violations).toHaveLength(0);
  });

  it('同源重复证据被识别', () => {
    const a = makeCandidateEvidenceContentFixture();
    const b = makeCandidateEvidenceContentFixture({ strength: 'strong' });
    expect(isDuplicateEvidence(b, [a])).toBe(true);
    const different = makeCandidateEvidenceContentFixture({ capabilityKey: 'other_capability', summary: '不同能力的证据。' });
    expect(isDuplicateEvidence(different, [a])).toBe(false);
  });

  it('insufficient 指引说明还需补什么证据', () => {
    expect(describeInsufficientGuidance(0, 0).length).toBeGreaterThan(0);
    expect(describeInsufficientGuidance(2, 0).some((g) => g.includes('反证'))).toBe(true);
  });
});
