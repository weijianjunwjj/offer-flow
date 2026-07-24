/**
 * ruleOverrideProjection 纯函数单测（V8-3 reviewService 与 V8-4 inputSnapshot 共享的权威投影）。
 * 仅覆盖既有语义，不扩展产品能力：set / reverted / set→revert 终态 none /
 * 多条动作按 occurredAt DESC 取最近 set / 投影枚举映射。
 */
import { describe, expect, it } from 'vitest';
import type { RadarAction } from '../../src/domain/radar';
import {
  currentOverrideState,
  overrideStateToProjection,
} from './ruleOverrideProjection';

/** 构造一条 rule_override_set/reverted 动作；actions 需按 occurredAt DESC 传入。 */
function action(over: Partial<RadarAction> & { id: string; occurredAt: number }): RadarAction {
  return {
    candidateId: 'cand-1',
    candidateVersionId: 'ver-1',
    actionType: 'rule_override_set',
    reasonCode: null,
    reasonText: null,
    metadata: { ruleAssessmentId: 'assess-1', overriddenValue: 'pass' },
    revertedByActionId: null,
    createdAt: over.occurredAt,
    ...over,
  };
}

describe('currentOverrideState', () => {
  it('returns none when no actions exist', () => {
    expect(currentOverrideState([], 'assess-1')).toBe('none');
  });

  it('returns the overridden value of the latest non-reverted set', () => {
    const actions = [action({ id: 'a1', occurredAt: 100 })];
    expect(currentOverrideState(actions, 'assess-1')).toBe('pass');
  });

  it('returns none when the latest set was reverted (set→revert → none)', () => {
    const actions = [action({ id: 'a1', occurredAt: 100, revertedByActionId: 'r1' })];
    expect(currentOverrideState(actions, 'assess-1')).toBe('none');
  });

  it('takes the most recent set by occurredAt DESC ordering across multiple actions', () => {
    // 传入即按 occurredAt DESC：最近一条为 block（未撤销）→ block。
    const actions = [
      action({ id: 'a3', occurredAt: 300, metadata: { ruleAssessmentId: 'assess-1', overriddenValue: 'block' } }),
      action({ id: 'a2', occurredAt: 200, revertedByActionId: 'r1' }),
      action({ id: 'a1', occurredAt: 100 }),
    ];
    expect(currentOverrideState(actions, 'assess-1')).toBe('block');
  });

  it('ignores actions targeting a different assessment', () => {
    const actions = [
      action({ id: 'a2', occurredAt: 200, metadata: { ruleAssessmentId: 'other', overriddenValue: 'block' } }),
      action({ id: 'a1', occurredAt: 100 }),
    ];
    expect(currentOverrideState(actions, 'assess-1')).toBe('pass');
  });

  it('ignores non-override action types', () => {
    const actions = [action({ id: 'a1', occurredAt: 100, actionType: 'saved' })];
    expect(currentOverrideState(actions, 'assess-1')).toBe('none');
  });

  it('returns none when overriddenValue is missing or invalid', () => {
    const actions = [action({ id: 'a1', occurredAt: 100, metadata: { ruleAssessmentId: 'assess-1' } })];
    expect(currentOverrideState(actions, 'assess-1')).toBe('none');
  });
});

describe('overrideStateToProjection', () => {
  it('maps pass/block to projection enums and none to null', () => {
    expect(overrideStateToProjection('pass')).toBe('overridden_pass');
    expect(overrideStateToProjection('block')).toBe('overridden_block');
    expect(overrideStateToProjection('none')).toBeNull();
  });
});
