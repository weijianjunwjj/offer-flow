import { describe, expect, it } from 'vitest';
import {
  CandidateEvidenceContentSchema,
  CapabilityBaselineDraftSchema,
  cloneCapabilityBaselineDraft,
  createEmptyCapabilityBaselineDraft,
  createEmptyCandidateEvidenceContent,
} from './index';
import {
  makeCandidateEvidenceContentFixture,
  makeCapabilityBaselineDraftFixture,
} from './testFixtures';

describe('能力基线严格 Schema', () => {
  it('空模板可通过严格 Schema', () => {
    expect(() => CapabilityBaselineDraftSchema.parse(createEmptyCapabilityBaselineDraft())).not.toThrow();
    expect(() => CandidateEvidenceContentSchema.parse(createEmptyCandidateEvidenceContent())).not.toThrow();
  });

  it('fixture 草案与证据合法', () => {
    expect(() => CapabilityBaselineDraftSchema.parse(makeCapabilityBaselineDraftFixture(['e1']))).not.toThrow();
    expect(() => CandidateEvidenceContentSchema.parse(makeCandidateEvidenceContentFixture())).not.toThrow();
  });

  it('拒绝未知字段（strict）', () => {
    expect(() => CapabilityBaselineDraftSchema.parse({
      ...makeCapabilityBaselineDraftFixture(), riskLevel: '旧字段',
    })).toThrow();
  });

  it('拒绝非法枚举', () => {
    expect(() => CandidateEvidenceContentSchema.parse(
      makeCandidateEvidenceContentFixture({ polarity: 'positive' as never }),
    )).toThrow();
    expect(() => CapabilityBaselineDraftSchema.parse({
      ...makeCapabilityBaselineDraftFixture(), overallConfidence: 'strong' as never,
    })).toThrow();
  });

  it('拒绝空必填字符串', () => {
    expect(() => CandidateEvidenceContentSchema.parse(
      makeCandidateEvidenceContentFixture({ summary: '' }),
    )).toThrow();
  });

  it('能力维度可动态扩展（不写死条数）', () => {
    const draft = makeCapabilityBaselineDraftFixture(['e1']);
    draft.capabilities.push({
      key: 'extra', label: '扩展能力', conclusion: '证据不足，尚待验证', conclusionStatus: 'insufficient',
      supportingEvidenceRefs: [], counterEvidenceRefs: [], unverified: ['需要补充证据'], largestUncertainty: '样本不足',
    });
    expect(() => CapabilityBaselineDraftSchema.parse(draft)).not.toThrow();
    expect(cloneCapabilityBaselineDraft(draft).capabilities).toHaveLength(2);
  });
});
