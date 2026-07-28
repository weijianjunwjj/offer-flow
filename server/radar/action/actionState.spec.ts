import { describe, expect, it } from 'vitest';
import type { RadarAction, RadarActionType } from '../../../src/domain/radar';
import { activeSetAction, deriveActionState } from './actionState';

let seq = 0;
function act(actionType: RadarActionType, over: Partial<RadarAction> = {}): RadarAction {
  seq += 1;
  return {
    id: over.id ?? `a-${seq}`,
    candidateId: 'cand-1',
    candidateVersionId: 'ver-1',
    actionType,
    reasonCode: null,
    reasonText: null,
    metadata: {},
    occurredAt: over.occurredAt ?? seq * 1000,
    revertedByActionId: over.revertedByActionId ?? null,
    createdAt: over.occurredAt ?? seq * 1000,
    ...over,
  };
}

describe('deriveActionState', () => {
  it('空事件流四族均为 false', () => {
    expect(deriveActionState([])).toEqual({
      saved: false, ignored: false, priority: false, appliedPending: false,
    });
  });

  it('未撤销的 set 事件使对应族生效', () => {
    const actions = [act('saved'), act('marked_priority')];
    expect(deriveActionState(actions)).toMatchObject({ saved: true, priority: true, ignored: false });
  });

  it('被回填 reverted_by_action_id 的 set 事件不再生效', () => {
    const saved = act('saved', { id: 's1' });
    const unsaved = act('unsaved', { revertedByActionId: null });
    const revertedSaved = { ...saved, revertedByActionId: unsaved.id };
    expect(deriveActionState([revertedSaved, unsaved]).saved).toBe(false);
  });

  it('re-set 后旧撤销事件不影响：存在新的未撤销 set 即生效', () => {
    const first = act('ignored', { id: 'i1', revertedByActionId: 'r1' });
    const revert = act('ignore_reverted', { id: 'r1' });
    const second = act('ignored', { id: 'i2' });
    expect(deriveActionState([first, revert, second]).ignored).toBe(true);
    expect(activeSetAction([first, revert, second], 'ignore')!.id).toBe('i2');
  });

  it('applied_pending 独立于其它族', () => {
    expect(deriveActionState([act('marked_applied_pending')]))
      .toEqual({ saved: false, ignored: false, priority: false, appliedPending: true });
  });
});
