import { describe, expect, it } from 'vitest';
import { makeApplication, makeEvent, makeLegacyEvent, makeVoidEvent } from '../../domain/job-memory/testFixtures';
import { projectApplication, type ApplicationMemory, type FeedbackEventRecord } from '../../domain/job-memory';
import {
  AUDIT_EVENT_TYPES,
  HIGH_IMPACT_EVENT_TYPES,
  USER_EVENT_TYPES,
  buildAppendFeedbackEventRequest,
  buildTimelineEntries,
  buildUserEventInput,
  buildVoidFeedbackEventRequest,
  canVoidTimelineEvent,
  createEmptyEventDraft,
  createEventVoidDraft,
  fingerprintEventDrafts,
} from './feedbackTimelineModel';

function memory(events: FeedbackEventRecord[] = [makeEvent('application_created')]): ApplicationMemory {
  const record = makeApplication();
  return { record, events, projection: projectApplication(record, events) };
}

describe('FeedbackTimeline 页面模型', () => {
  it('用户白名单与 B2 一致，audit-only 类型不暴露', () => {
    expect(USER_EVENT_TYPES).toHaveLength(22);
    for (const eventType of AUDIT_EVENT_TYPES) expect(USER_EVENT_TYPES).not.toContain(eventType);
    expect(USER_EVENT_TYPES).toEqual(expect.arrayContaining([
      'applied', 'hr_contacted', 'follow_up_sent', 'no_response_recorded',
      'interview_scheduled', 'offer_received', 'rejected', 'user_withdrew', 'position_closed',
    ]));
  });

  it('unknown 不伪造 eventAt，命令重试复用草稿中的同一幂等键', () => {
    const draft = createEmptyEventDraft('boss');
    draft.eventType = 'greeting_sent';
    const first = buildAppendFeedbackEventRequest(draft, 3);
    const second = buildAppendFeedbackEventRequest(draft, 3);
    expect(first.value).toMatchObject({
      idempotencyKey: draft.idempotencyKey,
      expectedApplicationVersion: 3,
      eventAt: null,
      timePrecision: 'unknown',
      payload: {},
    });
    expect(second.value?.idempotencyKey).toBe(first.value?.idempotencyKey);
  });

  it('no_response 必须填写 observedAsOf，且不会转换成 rejected payload', () => {
    const draft = createEmptyEventDraft('boss');
    draft.eventType = 'no_response_recorded';
    expect(buildUserEventInput(draft)).toMatchObject({ ok: false });
    draft.observedAsOfInput = '2026-07-13T12:00';
    const result = buildUserEventInput(draft);
    expect(result.value).toMatchObject({
      eventType: 'no_response_recorded',
      payload: { observedAsOf: expect.any(Number) },
    });
  });

  it('hr_contacted 只生成严格专用 payload，rejected 原因不从 note 推断', () => {
    const contacted = createEmptyEventDraft('boss');
    contacted.eventType = 'hr_contacted';
    contacted.hrContactedSubmissionState = 'not_applied';
    expect(buildUserEventInput(contacted).value).toMatchObject({
      payload: { submissionState: 'not_applied' },
    });

    const rejected = createEmptyEventDraft('boss');
    rejected.eventType = 'rejected';
    rejected.note = '学历不符合';
    expect(buildUserEventInput(rejected).value).toMatchObject({ reasonCode: null, payload: {} });
    expect(HIGH_IMPACT_EVENT_TYPES.has(rejected.eventType)).toBe(true);
  });

  it('按业务时间、记录时间、ID 倒序稳定展示，并保留 audit/legacy seed', () => {
    const exact = makeEvent('hr_replied', { id: 'a', idempotencyKey: 'a', eventAt: 200, createdAt: 500 });
    const sameLaterId = makeEvent('applied', { id: 'z', idempotencyKey: 'z', eventAt: 200, createdAt: 500 });
    const unknown = makeEvent('greeting_sent', {
      id: 'unknown', idempotencyKey: 'unknown', eventAt: null, timePrecision: 'unknown', createdAt: 300,
    });
    const legacy = makeLegacyEvent({ id: 'legacy', idempotencyKey: 'legacy', createdAt: 100 });
    const entries = buildTimelineEntries([legacy, exact, unknown, sameLaterId]);
    expect(entries.map(({ event }) => event.id)).toEqual(['unknown', 'z', 'a', 'legacy']);
    expect(entries.find(({ event }) => event.id === 'legacy')?.auditLabel).toBe('迁移兼容');
  });

  it('被 void 事件仍显示原因与 replacement 关联，且不允许再次作废', () => {
    const target = makeEvent('rejected', { id: 'target', idempotencyKey: 'target-key' });
    const voidEvent = makeVoidEvent(target, { id: 'void', idempotencyKey: 'void-key' });
    const replacement = makeEvent('hr_replied', {
      id: 'replacement', idempotencyKey: 'void-key:replacement', createdAt: voidEvent.createdAt,
    });
    const entries = buildTimelineEntries([target, voidEvent, replacement]);
    const targetEntry = entries.find(({ event }) => event.id === target.id)!;
    expect(targetEntry).toMatchObject({
      isVoided: true,
      voidEvent: { id: 'void', payload: { reason: '修正误录事件' } },
      replacementEvent: { id: 'replacement' },
    });
    expect(canVoidTimelineEvent(memory([target, voidEvent, replacement]), targetEntry)).toBe(false);
    expect(canVoidTimelineEvent(
      memory([target]),
      buildTimelineEntries([target])[0]!,
    )).toBe(true);
  });

  it('void + replacement 使用目标 Application 当前版本并保留同一命令 key', () => {
    const draft = createEventVoidDraft('target', 'boss');
    draft.reason = '误录为拒绝';
    draft.replacementEnabled = true;
    draft.replacementEvent.eventType = 'hr_replied';
    const before = fingerprintEventDrafts(null, draft);
    const result = buildVoidFeedbackEventRequest(draft, 7);
    expect(result.value).toMatchObject({
      idempotencyKey: draft.idempotencyKey,
      expectedApplicationVersion: 7,
      reason: '误录为拒绝',
      replacementEvent: { eventType: 'hr_replied' },
    });
    expect(fingerprintEventDrafts(null, draft)).toBe(before);
  });
});
