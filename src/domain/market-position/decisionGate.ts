import type { DecisionGate, DecisionGateStatus, DecisionGateType, EvidenceSufficiency } from './types';

/**
 * 高风险决策门：放弃方向与触发搬迁。产品定义明确要求系统"绝不自动放弃职业方向、
 * 绝不自动触发搬迁"，因此这两个门无论证据等级多高都不会到达 decision_ready，
 * 最高只能到 observe_only（供用户自行判断），其余门遵循标准三级映射。
 */
const HIGH_STAKES_GATES: readonly DecisionGateType[] = ['abandon_direction', 'relocation_decision'];

const GATE_LABELS: Record<DecisionGateType, string> = {
  role_positioning: '角色定位',
  city_priority: '城市优先级',
  salary_positioning: '薪资定位',
  resume_effectiveness: '简历有效性',
  channel_effectiveness: '渠道有效性',
  abandon_direction: '放弃当前方向',
  relocation_decision: '搬迁决策',
};

function statusForStandardGate(evidenceLevel: EvidenceSufficiency['evidenceLevel']): DecisionGateStatus {
  if (evidenceLevel === 'insufficient') return 'blocked';
  if (evidenceLevel === 'directional') return 'observe_only';
  return 'decision_ready';
}

function statusForHighStakesGate(evidenceLevel: EvidenceSufficiency['evidenceLevel']): DecisionGateStatus {
  if (evidenceLevel === 'supported') return 'observe_only';
  return 'blocked';
}

function rationaleFor(gateType: DecisionGateType, status: DecisionGateStatus, sufficiency: EvidenceSufficiency): string {
  const label = GATE_LABELS[gateType];
  if (status === 'blocked') {
    return `当前证据等级为「${sufficiency.evidenceLevel}」，尚不足以支持关于${label}的任何判断，该决策门保持锁定。`;
  }
  if (status === 'observe_only') {
    return `当前证据等级为「${sufficiency.evidenceLevel}」，已出现一些与${label}相关的方向性信号，但样本仍有限，只能作为观察参考，不构成可执行结论。`;
  }
  return `当前证据等级为「${sufficiency.evidenceLevel}」，已达到本系统保守阈值，关于${label}已积累较充分的正式市场证据，可供用户参考决策，但最终决定仍需由用户本人做出。`;
}

function prohibitedActionsFor(gateType: DecisionGateType, status: DecisionGateStatus): string[] {
  const shared = ['系统不得基于本决策门自动执行任何变更', '不得在未经用户确认的情况下对外发起任何投递或沟通动作'];
  const highStakesAlways = HIGH_STAKES_GATES.includes(gateType)
    ? ['系统不得自动放弃当前职业方向', '系统不得自动触发搬迁或修改目标城市']
    : [];
  if (gateType === 'salary_positioning') {
    return [...shared, '系统不得自动降低或修改薪资期望', ...highStakesAlways];
  }
  if (gateType === 'city_priority' || gateType === 'relocation_decision') {
    return [...shared, '系统不得自动调整城市优先级或触发搬迁', ...highStakesAlways];
  }
  if (status !== 'decision_ready') {
    return [...shared, '在证据不足前不得展示任何可执行结论', ...highStakesAlways];
  }
  return [...shared, ...highStakesAlways];
}

function nextEvidenceActionsFor(status: DecisionGateStatus, sufficiency: EvidenceSufficiency): string[] {
  if (status === 'decision_ready') return [];
  return sufficiency.missingEvidence.length > 0
    ? sufficiency.missingEvidence
    : ['继续积累真实投递、回复与面试记录'];
}

function reversibleActionsFor(gateType: DecisionGateType, status: DecisionGateStatus): string[] {
  if (status !== 'decision_ready' && status !== 'observe_only') return [];
  if (gateType === 'resume_effectiveness') return ['可尝试调整简历版本并持续对比后续回复率变化'];
  if (gateType === 'channel_effectiveness') return ['可尝试调整投递渠道分布并持续观察后续效果'];
  if (gateType === 'role_positioning') return ['可尝试扩大或收窄目标岗位族范围并观察市场反馈'];
  return ['可继续观察，不建议立即执行不可逆变更'];
}

export function computeDecisionGate(gateType: DecisionGateType, sufficiency: EvidenceSufficiency): DecisionGate {
  const status = HIGH_STAKES_GATES.includes(gateType)
    ? statusForHighStakesGate(sufficiency.evidenceLevel)
    : statusForStandardGate(sufficiency.evidenceLevel);

  return {
    gateType,
    status,
    rationale: rationaleFor(gateType, status, sufficiency),
    supportingEvidence: status === 'blocked' ? [] : sufficiency.passedGates,
    counterEvidence: status === 'blocked' ? [] : sufficiency.failedGates,
    missingEvidence: sufficiency.missingEvidence,
    nextEvidenceActions: nextEvidenceActionsFor(status, sufficiency),
    reversibleActions: reversibleActionsFor(gateType, status),
    prohibitedActions: prohibitedActionsFor(gateType, status),
  };
}

export function computeAllDecisionGates(
  gateTypes: readonly DecisionGateType[],
  sufficiency: EvidenceSufficiency,
): DecisionGate[] {
  return gateTypes.map((gateType) => computeDecisionGate(gateType, sufficiency));
}
