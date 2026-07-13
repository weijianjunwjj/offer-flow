import { describe, expect, it } from 'vitest';
import { projectApplication } from './projectApplication';
import { selectDefaultApplication } from './selectDefaultApplication';
import { makeApplication, makeEvent } from './testFixtures';
import type { ApplicationWithProjection, FeedbackEventRecord } from './types';

function candidate(
  id: string,
  createdAt: number,
  events: FeedbackEventRecord[] = [],
  voided = false,
): ApplicationWithProjection {
  const application = makeApplication({
    id,
    createdAt,
    updatedAt: createdAt,
    ...(voided ? { voidedAt: createdAt + 1, voidReason: '误录' } : {}),
  });
  const ownedEvents = events.map((event) => ({ ...event, applicationId: id })) as FeedbackEventRecord[];
  return { application, projection: projectApplication(application, ownedEvents) };
}

function event(type: 'hr_replied' | 'rejected', time: number, suffix: string): FeedbackEventRecord {
  return makeEvent(type, {
    id: `event-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    eventAt: time,
    createdAt: time,
  });
}

describe('默认 Application 选择', () => {
  it('0 个返回 null，1 个活跃返回自身', () => {
    expect(selectDefaultApplication([])).toBeNull();
    const only = candidate('only', 100);
    expect(selectDefaultApplication([only])?.application.id).toBe('only');
  });

  it('优先活跃流程，再按 lastMeaningfulEventAt 倒序', () => {
    const closed = candidate('closed', 500, [event('rejected', 900, 'closed')]);
    const olderActive = candidate('older-active', 100, [event('hr_replied', 300, 'older')]);
    const newerActive = candidate('newer-active', 200, [event('hr_replied', 400, 'newer')]);
    expect(selectDefaultApplication([closed, olderActive, newerActive])?.application.id)
      .toBe('newer-active');
  });

  it('全部关闭时选择最近一条未作废流程', () => {
    const first = candidate('first', 100, [event('rejected', 200, 'first')]);
    const second = candidate('second', 200, [event('rejected', 300, 'second')]);
    expect(selectDefaultApplication([first, second])?.application.id).toBe('second');
  });

  it('排除 voided Application', () => {
    const activeVoided = candidate('voided', 500, [event('hr_replied', 900, 'voided')], true);
    const eligible = candidate('eligible', 100);
    expect(selectDefaultApplication([activeVoided, eligible])?.application.id).toBe('eligible');
  });

  it('优先 valid/degraded，全部 invalid 时返回 null', () => {
    const valid = candidate('valid', 100);
    const invalidBase = candidate('invalid', 500);
    const invalid: ApplicationWithProjection = {
      application: invalidBase.application,
      projection: {
        ...invalidBase.projection,
        projectionStatus: 'invalid',
        errors: [{ code: 'INVALID_EVENT', message: '测试中的非法投影' }],
      },
    };
    expect(invalid.projection.projectionStatus).toBe('invalid');
    expect(selectDefaultApplication([invalid, valid])?.application.id).toBe('valid');
    expect(selectDefaultApplication([invalid])).toBeNull();
  });

  it('相同业务时间按 createdAt/id 确定选择，输入顺序不影响结果', () => {
    const alpha = candidate('alpha', 200, [event('hr_replied', 500, 'alpha')]);
    const beta = candidate('beta', 200, [event('hr_replied', 500, 'beta')]);
    const first = selectDefaultApplication([alpha, beta]);
    const second = selectDefaultApplication([beta, alpha]);
    expect(first?.application.id).toBe('beta');
    expect(second?.application.id).toBe('beta');
  });

  it('不写 isCurrent，也不修改输入数组', () => {
    const first = candidate('first', 100);
    const second = candidate('second', 200);
    const input = Object.freeze([first, second]);
    expect(selectDefaultApplication(input)?.application.id).toBe('second');
    expect(input.map((item) => item.application.id)).toEqual(['first', 'second']);
    expect('isCurrent' in first.application).toBe(false);
  });
});
