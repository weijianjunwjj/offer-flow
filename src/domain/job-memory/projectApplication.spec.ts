import { describe, expect, it } from 'vitest';
import { projectApplication } from './projectApplication';
import { makeApplication, makeEvent, makeLegacyEvent, makeVoidEvent } from './testFixtures';
import type { FeedbackEventRecord, FeedbackEventType } from './types';

function at<Type extends FeedbackEventType>(
  eventType: Type,
  eventAt: number,
  suffix: string = eventType,
): Extract<FeedbackEventRecord, { eventType: Type }> {
  return makeEvent(eventType, {
    id: `event-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    eventAt,
    createdAt: eventAt + 10,
  });
}

function codes(result: ReturnType<typeof projectApplication>): string[] {
  return [...result.warnings, ...result.errors].map((issue) => issue.code);
}

describe('Application 事件投影', () => {
  it('无事件时保持 unknown，不把缺失当 false', () => {
    const projection = projectApplication(makeApplication(), []);
    expect(projection).toMatchObject({
      stage: 'created',
      outcome: null,
      submissionState: 'unknown',
      communicationStatus: 'not_contacted',
      projectionStatus: 'valid',
      isClosed: false,
      isVoided: false,
    });
  });

  it('application_created 是中性审计事件', () => {
    const projection = projectApplication(makeApplication(), [at('application_created', 200)]);
    expect(projection.stage).toBe('created');
    expect(projection.submissionState).toBe('unknown');
    expect(projection.lastMeaningfulEventAt).toBeNull();
  });

  it('outbound applied 与 inbound contact 严格区分 submissionState', () => {
    const applied = projectApplication(makeApplication({ origin: 'outbound' }), [at('applied', 200)]);
    expect(applied).toMatchObject({ stage: 'applied', submissionState: 'applied', appliedAt: 200 });

    const inbound = makeEvent('hr_contacted', {
      id: 'event-inbound',
      idempotencyKey: 'key-inbound',
      eventAt: 300,
      createdAt: 310,
      payload: { submissionState: 'not_applied' },
    });
    const contacted = projectApplication(makeApplication({ origin: 'inbound' }), [inbound]);
    expect(contacted).toMatchObject({
      stage: 'contacted',
      submissionState: 'not_applied',
      communicationStatus: 'replied',
    });
  });

  it('映射 greeting、viewed、reply、screening、interview 和 offer', () => {
    const application = makeApplication();
    expect(projectApplication(application, [at('greeting_sent', 100)]).communicationStatus)
      .toBe('greeted_unread');
    expect(projectApplication(application, [at('greeting_sent', 100), at('message_viewed', 200)]).communicationStatus)
      .toBe('greeted_read_no_reply');
    expect(projectApplication(application, [at('hr_replied', 300)]).communicationStatus).toBe('replied');
    expect(projectApplication(application, [at('resume_requested', 400)]).stage).toBe('screening');
    expect(projectApplication(application, [at('phone_screen', 400)]).stage).toBe('screening');
    expect(projectApplication(application, [at('interview_scheduled', 500)]).stage).toBe('interviewing');
    expect(projectApplication(application, [at('interview_completed', 500)]).stage).toBe('interviewing');
    expect(projectApplication(application, [at('interview_advanced', 500)]).stage).toBe('interviewing');
    expect(projectApplication(application, [at('offer_received', 600)])).toMatchObject({
      stage: 'offer',
      outcome: null,
      isClosed: false,
      communicationStatus: 'replied',
    });
  });

  it.each([
    ['rejected', 'rejected', 'rejected'],
    ['user_withdrew', 'user_withdrew', 'closed'],
    ['position_closed', 'position_closed', 'closed'],
    ['marked_stale', 'stale', 'closed'],
    ['offer_accepted', 'offer_accepted', 'closed'],
    ['offer_declined', 'offer_declined', 'closed'],
  ] as const)('%s 关闭流程且保持独立 outcome', (eventType, outcome, communicationStatus) => {
    const projection = projectApplication(makeApplication(), [at(eventType, 500)]);
    expect(projection).toMatchObject({
      stage: 'closed', outcome, communicationStatus, isClosed: true,
    });
  });

  it('no_response_recorded 只记录观察，不关闭或拒绝', () => {
    const observed = makeEvent('no_response_recorded', {
      id: 'event-observed',
      idempotencyKey: 'key-observed',
      eventAt: 200,
      createdAt: 210,
      payload: { observedAsOf: 900 },
    });
    const projection = projectApplication(makeApplication(), [at('greeting_sent', 100), observed]);
    expect(projection).toMatchObject({
      stage: 'contacted', outcome: null, isClosed: false, communicationStatus: 'greeted_unread',
      lastMeaningfulEventAt: 900,
    });
  });

  it('只有 follow_up_sent 计数，并从精确动作时间计算 cooldown', () => {
    const projection = projectApplication(makeApplication(), [
      at('greeting_sent', 100, 'greeting'),
      at('follow_up_sent', 200, 'follow-1'),
      at('follow_up_sent', 300, 'follow-2'),
    ]);
    expect(projection.followUpCount).toBe(2);
    expect(projection.lastGreetedAt).toBe(100);
    expect(projection.lastFollowUpAt).toBe(300);
    expect(projection.nextAllowedFollowUpAt).toBe(300 + 3 * 24 * 60 * 60 * 1000);
  });

  it('无精确 greeting/follow-up 时间时不伪造 cooldown', () => {
    const greeting = makeEvent('greeting_sent', {
      eventAt: null,
      timePrecision: 'unknown',
      createdAt: 500,
    });
    const projection = projectApplication(makeApplication(), [greeting]);
    expect(projection.lastGreetedAt).toBeNull();
    expect(projection.nextAllowedFollowUpAt).toBeNull();
  });

  it('被 void 的 follow-up 不计数', () => {
    const followUp = at('follow_up_sent', 200, 'follow');
    const projection = projectApplication(makeApplication(), [followUp, makeVoidEvent(followUp)]);
    expect(projection.followUpCount).toBe(0);
  });

  it('按 eventAt、createdAt、id 稳定排序，迟到录入与输入乱序结果一致', () => {
    const replied = makeEvent('hr_replied', {
      id: 'event-z', idempotencyKey: 'key-z', eventAt: 200, createdAt: 900,
    });
    const interview = makeEvent('interview_scheduled', {
      id: 'event-a', idempotencyKey: 'key-a', eventAt: 300, createdAt: 400,
    });
    const first = projectApplication(makeApplication(), [interview, replied]);
    const second = projectApplication(makeApplication(), [replied, interview]);
    expect(first).toEqual(second);
    expect(first.stage).toBe('interviewing');

    const sameA = makeEvent('interview_scheduled', {
      id: 'a', idempotencyKey: 'same-a', eventAt: 500, createdAt: 500,
    });
    const sameB = makeEvent('hr_replied', {
      id: 'b', idempotencyKey: 'same-b', eventAt: 500, createdAt: 500,
    });
    expect(projectApplication(makeApplication(), [sameB, sameA]).stage).toBe('contacted');
  });

  it('legacy seed 总是先应用，真实正常事件优先，即使 seed createdAt 更晚', () => {
    const legacy = makeLegacyEvent({
      createdAt: 9_000,
      payload: {
        legacyStatus: 'rejected',
        lastGreetedAt: 100,
        lastFollowupAt: null,
        followupCount: 0,
        note: '旧状态',
      },
    });
    const reply = makeEvent('hr_replied', {
      id: 'event-real-reply', idempotencyKey: 'key-real-reply', eventAt: 10_000, createdAt: 1_000,
    });
    const projection = projectApplication(makeApplication(), [reply, legacy]);
    expect(projection).toMatchObject({ stage: 'contacted', outcome: null, isClosed: false });
    expect(codes(projection)).toContain('LEGACY_SEED_APPLIED');
  });

  it('多个 legacy seed 稳定选择 createdAt/id 最早项并 degraded', () => {
    const later = makeLegacyEvent({
      id: 'legacy-b', idempotencyKey: 'legacy-key-b', createdAt: 500,
      payload: { legacyStatus: 'replied', lastGreetedAt: null, lastFollowupAt: null, followupCount: 0, note: null },
    });
    const earlier = makeLegacyEvent({
      id: 'legacy-a', idempotencyKey: 'legacy-key-a', createdAt: 400,
      payload: { legacyStatus: 'interviewing', lastGreetedAt: null, lastFollowupAt: null, followupCount: 0, note: null },
    });
    const projection = projectApplication(makeApplication(), [later, earlier]);
    expect(projection.stage).toBe('interviewing');
    expect(codes(projection)).toContain('MULTIPLE_LEGACY_SEEDS');
    expect(projection.projectionStatus).toBe('degraded');
  });

  it('void 普通事件后可用替代事件重算', () => {
    const rejection = at('rejected', 200, 'rejection');
    const replacement = at('hr_replied', 300, 'replacement');
    const projection = projectApplication(makeApplication(), [
      rejection,
      makeVoidEvent(rejection),
      replacement,
    ]);
    expect(projection).toMatchObject({ stage: 'contacted', outcome: null, isClosed: false });
  });

  it('void 不存在目标和重复 void 产生 degraded warning', () => {
    const missing = makeEvent('event_voided', {
      id: 'void-missing', idempotencyKey: 'void-missing-key',
      payload: { targetEventId: 'missing', targetEventType: 'rejected', reason: '目标不存在' },
    });
    const greeting = at('greeting_sent', 100, 'greeting');
    const firstVoid = makeVoidEvent(greeting, { id: 'void-1', idempotencyKey: 'void-key-1' });
    const secondVoid = makeVoidEvent(greeting, { id: 'void-2', idempotencyKey: 'void-key-2' });
    const projection = projectApplication(makeApplication(), [missing, greeting, firstVoid, secondVoid]);
    expect(codes(projection)).toEqual(expect.arrayContaining(['VOID_TARGET_NOT_FOUND', 'DUPLICATE_VOID']));
    expect(projection.projectionStatus).toBe('degraded');
  });

  it('跨 Application void、void 另一个 void 和 target type 错配均 invalid', () => {
    const otherTarget = makeEvent('greeting_sent', {
      id: 'other-target', applicationId: 'application-2', idempotencyKey: 'other-key',
    });
    const crossVoid = makeVoidEvent(otherTarget, {
      id: 'cross-void', applicationId: 'application-1', idempotencyKey: 'cross-key',
    });
    const voidTarget = makeEvent('event_voided', {
      id: 'void-target', idempotencyKey: 'void-target-key',
      payload: { targetEventId: 'missing', targetEventType: 'greeting_sent', reason: '首次 void' },
    });
    const voidAnotherVoid = makeEvent('event_voided', {
      id: 'void-another-void', idempotencyKey: 'void-another-key',
      payload: { targetEventId: voidTarget.id, targetEventType: 'application_created', reason: '非法' },
    });
    const reply = at('hr_replied', 300, 'reply');
    const wrongType = makeEvent('event_voided', {
      id: 'wrong-type', idempotencyKey: 'wrong-type-key',
      payload: { targetEventId: reply.id, targetEventType: 'rejected', reason: '类型错误' },
    });
    const projection = projectApplication(makeApplication(), [
      otherTarget, crossVoid, voidTarget, voidAnotherVoid, reply, wrongType,
    ]);
    expect(codes(projection)).toEqual(expect.arrayContaining([
      'EVENT_APPLICATION_MISMATCH',
      'VOID_TARGET_OTHER_APPLICATION',
      'VOID_TARGET_IS_VOID',
      'VOID_TARGET_TYPE_MISMATCH',
    ]));
    expect(projection.projectionStatus).toBe('invalid');
  });

  it('Application 行是作废事实源，审计事件不单独决定作废', () => {
    const audit = makeEvent('application_voided', {
      id: 'void-audit', idempotencyKey: 'void-audit-key', payload: { reason: '误录' },
    });
    const withBoth = projectApplication(makeApplication({ voidedAt: 500, voidReason: '误录' }), [audit]);
    expect(withBoth).toMatchObject({
      stage: 'closed', outcome: null, communicationStatus: 'closed', isClosed: true, isVoided: true,
      projectionStatus: 'valid',
    });

    const rowOnly = projectApplication(makeApplication({ voidedAt: 500, voidReason: '误录' }), []);
    expect(rowOnly.isVoided).toBe(true);
    expect(codes(rowOnly)).toContain('APPLICATION_VOID_AUDIT_MISSING');

    const auditOnly = projectApplication(makeApplication(), [audit]);
    expect(auditOnly).toMatchObject({ isVoided: false, isClosed: false, outcome: null });
    expect(codes(auditOnly)).toContain('APPLICATION_VOID_AUDIT_WITHOUT_ROW');
  });

  it('metadata correction 只是审计，不覆盖 Application 当前上下文', () => {
    const application = makeApplication({ channel: 'boss' });
    const audit = makeEvent('application_metadata_corrected', {
      payload: {
        correctedFields: ['channel'],
        before: { channel: 'unknown' },
        after: { channel: 'referral' },
        reason: '历史修正',
      },
    });
    const projection = projectApplication(application, [audit]);
    expect(application.channel).toBe('boss');
    expect(projection.stage).toBe('created');
  });

  it('pause/resume 恢复前一状态，无可恢复状态时 degraded', () => {
    const resumed = projectApplication(makeApplication(), [
      at('applied', 100), at('recruitment_paused', 200), at('process_resumed', 300),
    ]);
    expect(resumed).toMatchObject({ stage: 'applied', communicationStatus: 'not_contacted' });

    const missingPause = projectApplication(makeApplication(), [at('process_resumed', 100)]);
    expect(codes(missingPause)).toContain('RESUME_WITHOUT_PAUSE');
    expect(missingPause.projectionStatus).toBe('degraded');
  });

  it('frozen 是暂停而非拒绝，暂停后拒绝正常关闭', () => {
    const frozen = projectApplication(makeApplication(), [
      at('hr_replied', 100), at('recruitment_frozen', 200),
    ]);
    expect(frozen).toMatchObject({ stage: 'paused', outcome: null, isClosed: false });

    const rejected = projectApplication(makeApplication(), [
      at('hr_replied', 100), at('recruitment_paused', 200), at('rejected', 300),
    ]);
    expect(rejected).toMatchObject({ stage: 'closed', outcome: 'rejected', isClosed: true });
  });

  it.each([
    ['rejected', 'hr_replied'],
    ['offer_accepted', 'interview_scheduled'],
    ['position_closed', 'follow_up_sent'],
  ] as const)('%s 后的 %s 不重开并 degraded', (closeType, laterType) => {
    const projection = projectApplication(makeApplication(), [at(closeType, 100), at(laterType, 200)]);
    expect(projection.stage).toBe('closed');
    expect(projection.isClosed).toBe(true);
    expect(codes(projection)).toContain('EVENT_AFTER_CLOSED');
  });

  it('完全相同重复事件 degraded 去重；同 key 或同 ID 的不同内容 invalid', () => {
    const greeting = at('greeting_sent', 100, 'duplicate');
    const identical = projectApplication(makeApplication(), [greeting, { ...greeting }]);
    expect(identical.followUpCount).toBe(0);
    expect(codes(identical)).toContain('DUPLICATE_IDENTICAL_EVENT');

    const sameKeyDifferent = at('hr_replied', 200, 'same-key-different');
    sameKeyDifferent.idempotencyKey = greeting.idempotencyKey;
    const keyConflict = projectApplication(makeApplication(), [greeting, sameKeyDifferent]);
    expect(codes(keyConflict)).toContain('IDEMPOTENCY_KEY_CONFLICT');
    expect(keyConflict.projectionStatus).toBe('invalid');

    const sameIdDifferent = at('hr_replied', 200, 'same-id-different');
    sameIdDifferent.id = greeting.id;
    const idConflict = projectApplication(makeApplication(), [greeting, sameIdDifferent]);
    expect(codes(idConflict)).toContain('DUPLICATE_EVENT_ID');
  });

  it('事件不属于目标 Application 或 payload 非法时 invalid，不回退成可信状态', () => {
    const other = at('hr_replied', 100, 'other');
    other.applicationId = 'application-2';
    const malformed = { ...at('no_response_recorded', 200, 'malformed'), payload: {} } as FeedbackEventRecord;
    const projection = projectApplication(makeApplication(), [other, malformed]);
    expect(codes(projection)).toEqual(expect.arrayContaining(['EVENT_APPLICATION_MISMATCH', 'INVALID_EVENT']));
    expect(projection.projectionStatus).toBe('invalid');
  });

  it('非法 Application 输入返回 invalid 而不是抛出非预期异常', () => {
    const projection = projectApplication(null as unknown as ReturnType<typeof makeApplication>, []);
    expect(projection.projectionStatus).toBe('invalid');
    expect(codes(projection)).toContain('INVALID_APPLICATION');
  });

  it('不修改 application/events，冻结输入可重复得到相同结果', () => {
    const application = Object.freeze(makeApplication());
    const event = Object.freeze(at('greeting_sent', 100));
    const events = Object.freeze([event]);
    const first = projectApplication(application, events);
    const second = projectApplication(application, events);
    expect(first).toEqual(second);
    expect(application.voidedAt).toBeNull();
    expect(events).toHaveLength(1);
  });
});
