import type {
  CandidateEvidenceContent,
  CapabilityBaselineDraft,
  CapabilityBaselineState,
} from './types';

/**
 * 初始建议能力维度，仅作为用户手工建立提案时的结构提示。
 * 这些维度不是未经确认的正式事实：结论一律标记为 insufficient，
 * 结论文本明确要求补充证据，不得直接当作已验证能力。
 */
export const SUGGESTED_CAPABILITY_DIMENSIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'complex_backoffice_delivery', label: '复杂中后台交付' },
  { key: 'vue_typescript_engineering', label: 'Vue / TypeScript 工程能力' },
  { key: 'frontend_architecture', label: '前端架构与工程化' },
  { key: 'data_analysis_visualization', label: '数据分析与可视化' },
  { key: 'nodejs_backend_loop', label: 'Node.js 后端闭环' },
  { key: 'ai_application_engineering', label: 'AI 应用工程化' },
  { key: 'product_decision_translation', label: '产品理解与决策转化' },
];

export function createEmptyCandidateEvidenceContent(): CandidateEvidenceContent {
  return {
    capabilityKey: 'to_fill',
    capabilityLabel: '尚待填写能力维度',
    polarity: 'neutral',
    strength: 'weak',
    sourceType: 'user_input',
    sourceId: null,
    sourceLabel: '用户手工输入',
    city: null,
    summary: '尚待填写证据说明',
    observedAt: null,
    timePrecision: 'unknown',
    sourceConfidence: 'recalled',
  };
}

export function createEmptyCapabilityBaselineDraft(): CapabilityBaselineDraft {
  return {
    summary: '当前样本不足，暂不形成正式能力基线结论',
    capabilities: SUGGESTED_CAPABILITY_DIMENSIONS.map(({ key, label }) => ({
      key,
      label,
      conclusion: '证据不足，尚待验证',
      conclusionStatus: 'insufficient',
      supportingEvidenceRefs: [],
      counterEvidenceRefs: [],
      unverified: ['缺少已接受的支持证据', '缺少可比对的反证'],
      largestUncertainty: '当前样本不足，暂不形成正式结论',
    })),
    externalConstraints: [],
    overallConfidence: 'insufficient',
    largestUncertainties: ['当前尚无足够已接受证据形成正式能力基线'],
  };
}

export function createEmptyCapabilityBaselineState(): CapabilityBaselineState {
  return {
    stateVersion: 0,
    activeVersionId: null,
    evidence: [],
    versions: [],
    proposals: [],
    commandReceipts: [],
  };
}
