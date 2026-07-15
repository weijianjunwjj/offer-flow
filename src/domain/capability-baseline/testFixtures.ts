import type {
  CandidateEvidenceContent,
  CapabilityBaselineDraft,
} from './types';

export function makeCandidateEvidenceContentFixture(
  overrides: Partial<CandidateEvidenceContent> = {},
): CandidateEvidenceContent {
  return {
    capabilityKey: 'vue_typescript_engineering',
    capabilityLabel: 'Vue / TypeScript 工程能力',
    polarity: 'support',
    strength: 'medium',
    sourceType: 'resume_version',
    sourceId: 'resume-fixture',
    sourceLabel: '当前主简历',
    city: null,
    summary: '简历体现 Vue、TypeScript 与复杂 B 端交付经验。',
    observedAt: 1_700_000_000_000,
    timePrecision: 'date',
    sourceConfidence: 'approximate',
    ...overrides,
  };
}

/**
 * 生成一个引用给定已接受证据 id 的合法能力基线草案。
 * 若不传证据 id，则形成 insufficient 的空证据草案。
 */
export function makeCapabilityBaselineDraftFixture(
  supportingRefs: string[] = [],
  counterRefs: string[] = [],
): CapabilityBaselineDraft {
  return {
    summary: '基于现有已接受证据的长期能力基线；样本仍需扩充。',
    capabilities: [
      {
        key: 'vue_typescript_engineering',
        label: 'Vue / TypeScript 工程能力',
        conclusion: supportingRefs.length > 0
          ? '有简历与项目证据支持复杂前端交付能力。'
          : '证据不足，尚待验证。',
        conclusionStatus: supportingRefs.length > 0 ? 'supported' : 'insufficient',
        supportingEvidenceRefs: [...supportingRefs],
        counterEvidenceRefs: [...counterRefs],
        unverified: counterRefs.length === 0 ? ['缺少已核实的反证或边界说明'] : [],
        largestUncertainty: '大型生产级 AI 项目证据仍不足。',
      },
    ],
    externalConstraints: [
      {
        key: 'education_barrier',
        kind: 'education',
        label: '学历门槛',
        summary: '部分岗位要求全日制本科，属外部门槛，非能力事实。',
        evidenceRefs: [],
      },
    ],
    overallConfidence: supportingRefs.length > 0 ? 'exploratory' : 'insufficient',
    largestUncertainties: ['四城市独立样本量不足', '缺少大型 AI 生产项目证据'],
  };
}
