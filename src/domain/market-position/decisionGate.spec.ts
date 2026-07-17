import { describe, expect, it } from 'vitest';
import { computeAllDecisionGates, computeDecisionGate } from './decisionGate';
import { computeEvidenceSufficiency } from './evidenceSufficiency';
import { DECISION_GATE_TYPES, type EvidenceRawCounts, type MarketPositionScope } from './types';

const globalScope: MarketPositionScope = { scopeType: 'global', city: null, jobFamily: null };

const zeroCounts: EvidenceRawCounts = {
  applicationCount: 0,
  companyCount: 0,
  validReplyCount: 0,
  interviewCount: 0,
  terminalOutcomeCount: 0,
  exactCount: 0,
  dateLevelCount: 0,
  approximateCount: 0,
  recalledCount: 0,
  inferredCount: 0,
  firstObservedAt: null,
  lastObservedAt: null,
};

const supportedCounts: EvidenceRawCounts = {
  applicationCount: 40,
  companyCount: 20,
  validReplyCount: 15,
  interviewCount: 8,
  terminalOutcomeCount: 5,
  exactCount: 25,
  dateLevelCount: 10,
  approximateCount: 0,
  recalledCount: 3,
  inferredCount: 2,
  firstObservedAt: Date.parse('2025-01-01T00:00:00Z'),
  lastObservedAt: Date.parse('2026-06-01T00:00:00Z'),
};

describe('DecisionGate · 状态映射', () => {
  it('insufficient 时全部标准决策门 blocked', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, zeroCounts);
    const gates = computeAllDecisionGates(DECISION_GATE_TYPES, sufficiency);
    for (const gate of gates) {
      if (gate.gateType === 'abandon_direction' || gate.gateType === 'relocation_decision') continue;
      expect(gate.status).toBe('blocked');
      expect(gate.supportingEvidence).toHaveLength(0);
    }
  });

  it('放弃方向与搬迁决策在任何证据等级下都不会到达 decision_ready', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, supportedCounts);
    expect(sufficiency.evidenceLevel).toBe('supported');
    const abandon = computeDecisionGate('abandon_direction', sufficiency);
    const relocation = computeDecisionGate('relocation_decision', sufficiency);
    expect(abandon.status).toBe('observe_only');
    expect(relocation.status).toBe('observe_only');
    expect(abandon.prohibitedActions).toContain('系统不得自动放弃当前职业方向');
    expect(relocation.prohibitedActions).toContain('系统不得自动触发搬迁或修改目标城市');
  });

  it('supported 时标准决策门 decision_ready，且薪资/城市门始终包含禁止自动变更说明', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, supportedCounts);
    const gates = computeAllDecisionGates(DECISION_GATE_TYPES, sufficiency);
    const salaryGate = gates.find((g) => g.gateType === 'salary_positioning')!;
    const cityGate = gates.find((g) => g.gateType === 'city_priority')!;
    expect(salaryGate.status).toBe('decision_ready');
    expect(salaryGate.prohibitedActions).toContain('系统不得自动降低或修改薪资期望');
    expect(cityGate.status).toBe('decision_ready');
    expect(cityGate.prohibitedActions).toContain('系统不得自动调整城市优先级或触发搬迁');
  });

  it('directional 时标准决策门为 observe_only，携带缺失证据行动项', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, {
      applicationCount: 15,
      companyCount: 8,
      validReplyCount: 2,
      interviewCount: 1,
      terminalOutcomeCount: 0,
      exactCount: 8,
      dateLevelCount: 2,
      approximateCount: 0,
      recalledCount: 0,
      inferredCount: 0,
      firstObservedAt: Date.parse('2026-01-01T00:00:00Z'),
      lastObservedAt: Date.parse('2026-01-15T00:00:00Z'),
    });
    const roleGate = computeDecisionGate('role_positioning', sufficiency);
    expect(roleGate.status).toBe('observe_only');
    expect(roleGate.nextEvidenceActions.length).toBeGreaterThan(0);
  });

  it('每个决策门都输出完整的七个字段', () => {
    const sufficiency = computeEvidenceSufficiency(globalScope, zeroCounts);
    const gates = computeAllDecisionGates(DECISION_GATE_TYPES, sufficiency);
    for (const gate of gates) {
      expect(gate.rationale.length).toBeGreaterThan(0);
      expect(Array.isArray(gate.supportingEvidence)).toBe(true);
      expect(Array.isArray(gate.counterEvidence)).toBe(true);
      expect(Array.isArray(gate.missingEvidence)).toBe(true);
      expect(Array.isArray(gate.nextEvidenceActions)).toBe(true);
      expect(Array.isArray(gate.reversibleActions)).toBe(true);
      expect(Array.isArray(gate.prohibitedActions)).toBe(true);
    }
    expect(gates.map((g) => g.gateType).sort()).toEqual([...DECISION_GATE_TYPES].sort());
  });
});
