import { describe, expect, it } from 'vitest';
import {
  partitionActionTypes,
  windowTypeForEvidenceLevel,
} from './strategyWindow';
import { buildDeterministicStrategyDraft } from './draft';
import { makeStrategyWindow } from './testFixtures';

describe('StrategyWindow 确定性规则', () => {
  it('insufficient → 证据收集窗口', () => {
    expect(windowTypeForEvidenceLevel('insufficient')).toBe('evidence_collection');
    expect(makeStrategyWindow('insufficient').windowType).toBe('evidence_collection');
  });

  it('directional → 受控实验窗口', () => {
    expect(windowTypeForEvidenceLevel('directional')).toBe('controlled_experiment');
    expect(makeStrategyWindow('directional').windowType).toBe('controlled_experiment');
  });

  it('supported → 有限优化窗口', () => {
    expect(windowTypeForEvidenceLevel('supported')).toBe('limited_optimization');
    expect(makeStrategyWindow('supported').windowType).toBe('limited_optimization');
  });

  it('证据收集窗口下，降薪/搬迁/减少投入类动作被禁止，不进入允许清单', () => {
    const { allowedActionTypes, blockedActionTypes } = partitionActionTypes('evidence_collection');
    expect(blockedActionTypes).toEqual(
      expect.arrayContaining(['salary_probe', 'relocation_feasibility_research', 'reduce_exposure']),
    );
    for (const blocked of ['salary_probe', 'relocation_feasibility_research', 'reduce_exposure']) {
      expect(allowedActionTypes).not.toContain(blocked);
    }
  });

  it('受控实验窗口允许薪资试探，但仍禁止搬迁研究与减少投入', () => {
    const { allowedActionTypes, blockedActionTypes } = partitionActionTypes('controlled_experiment');
    expect(allowedActionTypes).toContain('salary_probe');
    expect(blockedActionTypes).toEqual(
      expect.arrayContaining(['relocation_feasibility_research', 'reduce_exposure']),
    );
  });

  it('有限优化窗口把搬迁研究降级为仅观察，且不再有被完全禁止的动作类型', () => {
    const { observeOnlyActionTypes, blockedActionTypes, allowedActionTypes } = partitionActionTypes('limited_optimization');
    expect(observeOnlyActionTypes).toContain('relocation_feasibility_research');
    expect(allowedActionTypes).toContain('reduce_exposure');
    expect(blockedActionTypes).toEqual([]);
  });

  it('放弃方向与直接搬迁不属于任何允许的 actionType（系统绝不直接放弃或搬迁）', () => {
    for (const level of ['insufficient', 'directional', 'supported'] as const) {
      const window = makeStrategyWindow(level);
      // 高风险门快照存在且 abandon_direction / relocation_decision 从不 decision_ready。
      const abandon = window.decisionGateSnapshot.find((g) => g.gateType === 'abandon_direction');
      const relocation = window.decisionGateSnapshot.find((g) => g.gateType === 'relocation_decision');
      expect(abandon?.status).not.toBe('decision_ready');
      expect(relocation?.status).not.toBe('decision_ready');
      // relocation 研究最多为“仅观察”，绝不进入“现在可以做”。
      expect(window.allowedActionTypes).not.toContain('relocation_feasibility_research');
    }
  });

  it('复盘触发条件包含 14 天到期与上游版本变化', () => {
    const window = makeStrategyWindow('insufficient');
    expect(window.reviewTriggers.some((t) => t.includes('14'))).toBe(true);
    expect(window.reviewTriggers.some((t) => t.includes('active'))).toBe(true);
    expect(window.reviewAt).toBeGreaterThan(window.startsAt);
    expect(window.expiresAt).toBeGreaterThan(window.reviewAt);
  });

  it('确定性草稿的全部行动在 insufficient/directional 阶段均为可逆', () => {
    for (const level of ['insufficient', 'directional'] as const) {
      const window = makeStrategyWindow(level);
      const draft = buildDeterministicStrategyDraft(window, { createId: () => 'sa' });
      expect(draft.actions.every((action) => action.reversible)).toBe(true);
      expect(draft.experiments.every((exp) => exp.reversible)).toBe(true);
    }
  });

  it('无证据（insufficient）时城市分配只能是探索性样本', () => {
    const window = makeStrategyWindow('insufficient');
    const draft = buildDeterministicStrategyDraft(window, { createId: () => 'sa' });
    const cityPlan = draft.allocationPlans.find((plan) => plan.dimension === 'city');
    expect(cityPlan?.entries.every((entry) => entry.exploratory)).toBe(true);
    const total = cityPlan?.entries.reduce((sum, entry) => sum + entry.share, 0);
    expect(total).toBeCloseTo(100, 5);
  });
});
