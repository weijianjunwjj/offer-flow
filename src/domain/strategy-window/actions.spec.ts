import { describe, expect, it } from 'vitest';
import { validateStrategyDraft } from './actions';
import { buildDeterministicStrategyDraft } from './draft';
import { makeStrategyWindow } from './testFixtures';
import type { StrategyProposalDraft } from './types';

const ACCEPTED = ['ev-1', 'ev-2'];

function validDraft(level: 'insufficient' | 'directional' | 'supported' = 'directional'): {
  window: ReturnType<typeof makeStrategyWindow>;
  draft: StrategyProposalDraft;
} {
  const window = makeStrategyWindow(level);
  const draft = buildDeterministicStrategyDraft(window, { createId: (() => { let n = 0; return () => `sa-${++n}`; })() });
  return { window, draft };
}

describe('validateStrategyDraft 门禁校验', () => {
  it('确定性草稿本身通过全部门禁', () => {
    const { window, draft } = validDraft();
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })).toEqual([]);
  });

  it('同一分配维度比例总和不为 100 时拒绝', () => {
    const { window, draft } = validDraft();
    const cityPlan = draft.allocationPlans.find((p) => p.dimension === 'city')!;
    cityPlan.entries[0].share += 10;
    const errors = validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED });
    expect(errors.some((e) => e.code === 'allocation_invalid')).toBe(true);
  });

  it('分配比例为负数或超过 100 时拒绝', () => {
    const { window, draft } = validDraft();
    const plan = draft.allocationPlans[0];
    plan.entries[0].share = -5;
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'allocation_invalid')).toBe(true);
    plan.entries[0].share = 140;
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'allocation_invalid')).toBe(true);
  });

  it('insufficient 阶段出现不可逆行动时拒绝', () => {
    const { window, draft } = validDraft('insufficient');
    draft.actions[0].reversible = false;
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'irreversible_action')).toBe(true);
  });

  it('A/B 实验同时改变多个核心变量时拒绝', () => {
    const { window, draft } = validDraft();
    if (draft.experiments.length === 0) {
      draft.experiments.push({
        id: 'exp-x', actionType: 'resume_ab_test', title: '多变量实验',
        variable: '简历版本+投递渠道', variantA: 'A', variantB: 'B',
        sampleTarget: 5, observationMetric: '回复', endCondition: '到期', reversible: true,
      });
    } else {
      draft.experiments[0].variable = '简历版本 和 渠道';
    }
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'ab_multi_variable')).toBe(true);
  });

  it('引用不存在或未被接受的证据 ID 时拒绝', () => {
    const { window, draft } = validDraft();
    draft.actions[0].sourceEvidenceIds = ['ev-does-not-exist'];
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'evidence_reference_invalid')).toBe(true);
  });

  it('允许合法引用已接受证据 ID', () => {
    const { window, draft } = validDraft();
    draft.actions[0].sourceEvidenceIds = ['ev-1'];
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })).toEqual([]);
  });

  it('使用当前窗口禁止的 actionType 时拒绝', () => {
    const { window, draft } = validDraft('insufficient');
    // salary_probe 在证据收集窗口被禁止。
    draft.actions[0].actionType = 'salary_probe';
    draft.actions[0].sourceDecisionGate = 'salary_positioning';
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'action_blocked')).toBe(true);
  });

  it('无证据城市的分配未标注探索性时拒绝', () => {
    const { window, draft } = validDraft('insufficient');
    const cityPlan = draft.allocationPlans.find((p) => p.dimension === 'city')!;
    cityPlan.entries[0].exploratory = false;
    expect(validateStrategyDraft(draft, { window, acceptedEvidenceIds: ACCEPTED })
      .some((e) => e.code === 'allocation_invalid')).toBe(true);
  });
});
