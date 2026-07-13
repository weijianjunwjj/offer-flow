import { describe, expect, it } from 'vitest';
import {
  ApplicationRecordSchema,
  ApplicationProjectionSchema,
  FeedbackEventRecordSchema,
  ResumeVersionRecordSchema,
} from './schemas';
import { projectApplication } from './projectApplication';
import { makeApplication, makeEvent, makeLegacyEvent } from './testFixtures';

describe('Job Memory 运行时 Schema', () => {
  it('接受显式 unknown 与 null 的合法 Application', () => {
    expect(ApplicationRecordSchema.parse(makeApplication())).toMatchObject({
      origin: 'unknown',
      channel: 'unknown',
      resumeVersionId: null,
      cityContext: { jobCity: null, marketCity: null, workMode: 'unknown' },
    });
  });

  it('拒绝空 ID、非法 rowVersion 和作废时间不变量', () => {
    expect(ApplicationRecordSchema.safeParse(makeApplication({ id: ' ' })).success).toBe(false);
    expect(ApplicationRecordSchema.safeParse(makeApplication({ rowVersion: 0 })).success).toBe(false);
    expect(ApplicationRecordSchema.safeParse(makeApplication({
      voidedAt: 99,
      voidReason: '误录',
    })).success).toBe(false);
    expect(ApplicationRecordSchema.safeParse(makeApplication({
      voidedAt: 200,
      voidReason: null,
    })).success).toBe(false);
  });

  it('channel=other 强制 label，其他 channel 禁止 label', () => {
    expect(ApplicationRecordSchema.safeParse(makeApplication({
      channel: 'other',
      channelOtherLabel: null,
    })).success).toBe(false);
    expect(ApplicationRecordSchema.safeParse(makeApplication({
      channel: 'boss',
      channelOtherLabel: '其他平台',
    })).success).toBe(false);
    expect(ApplicationRecordSchema.safeParse(makeApplication({
      channel: 'other',
      channelOtherLabel: '线下招聘会',
    })).success).toBe(true);
  });

  it('正式 Application 拒绝未知字段', () => {
    expect(ApplicationRecordSchema.safeParse({ ...makeApplication(), unexpected: true }).success).toBe(false);
  });

  it('ResumeVersion 使用明确内容快照并约束归档时间', () => {
    const valid = {
      id: 'resume-1',
      name: '前端主简历',
      source: 'profile_snapshot',
      contentHash: 'sha256-value',
      summary: '',
      contentSnapshot: { resumeText: '简历', projectExperience: '项目' },
      createdAt: 100,
      archivedAt: null,
      rowVersion: 1,
    };
    expect(ResumeVersionRecordSchema.safeParse(valid).success).toBe(true);
    expect(ResumeVersionRecordSchema.safeParse({ ...valid, archivedAt: 99 }).success).toBe(false);
    expect(ResumeVersionRecordSchema.safeParse({ ...valid, rowVersion: -1 }).success).toBe(false);
  });

  it('eventAt 与 unknown 时间精度必须双向一致', () => {
    expect(FeedbackEventRecordSchema.safeParse(makeEvent('applied', {
      eventAt: null,
      timePrecision: 'unknown',
    })).success).toBe(true);
    expect(FeedbackEventRecordSchema.safeParse(makeEvent('applied', {
      eventAt: null,
      timePrecision: 'exact',
    })).success).toBe(false);
    expect(FeedbackEventRecordSchema.safeParse(makeEvent('applied', {
      eventAt: 100,
      timePrecision: 'unknown',
    })).success).toBe(false);
  });

  it('拒绝 payload 类型错配和未知字段', () => {
    expect(FeedbackEventRecordSchema.safeParse({
      ...makeEvent('no_response_recorded'),
      payload: {},
    }).success).toBe(false);
    expect(FeedbackEventRecordSchema.safeParse({
      ...makeEvent('greeting_sent'),
      payload: { arbitrary: true },
    }).success).toBe(false);
  });

  it('legacy payload 拒绝负 followupCount 并强制迁移来源', () => {
    expect(FeedbackEventRecordSchema.safeParse(makeLegacyEvent({
      payload: {
        legacyStatus: 'replied',
        lastGreetedAt: null,
        lastFollowupAt: null,
        followupCount: -1,
        note: null,
      },
    })).success).toBe(false);
    expect(FeedbackEventRecordSchema.safeParse({
      ...makeLegacyEvent(),
      recordedBy: 'user',
    }).success).toBe(false);
  });

  it('event_voided 顶层 target 与 payload 必须一致', () => {
    const event = makeEvent('event_voided');
    expect(FeedbackEventRecordSchema.safeParse({
      ...event,
      targetEventId: 'different-target',
    }).success).toBe(false);
  });

  it('event_voided 类型层拒绝指向另一个 void', () => {
    const event = makeEvent('event_voided');
    expect(FeedbackEventRecordSchema.safeParse({
      ...event,
      payload: { ...event.payload, targetEventType: 'event_voided' },
    }).success).toBe(false);
  });

  it('metadata correction 只允许白名单且 before/after 对齐', () => {
    const event = makeEvent('application_metadata_corrected');
    expect(FeedbackEventRecordSchema.safeParse(event).success).toBe(true);
    expect(FeedbackEventRecordSchema.safeParse({
      ...event,
      payload: {
        correctedFields: ['channel'],
        before: { channel: 'unknown' },
        after: {},
        reason: '修正渠道',
      },
    }).success).toBe(false);
    expect(FeedbackEventRecordSchema.safeParse({
      ...event,
      payload: {
        correctedFields: ['channel'],
        before: { channel: 'unknown', rowVersion: 1 },
        after: { channel: 'boss' },
        reason: '修正渠道',
      },
    }).success).toBe(false);
  });

  it('Projection Schema 拒绝状态、issue 和作废组合不一致', () => {
    const valid = projectApplication(makeApplication(), []);
    expect(ApplicationProjectionSchema.safeParse(valid).success).toBe(true);
    expect(ApplicationProjectionSchema.safeParse({
      ...valid,
      projectionStatus: 'degraded',
    }).success).toBe(false);
    expect(ApplicationProjectionSchema.safeParse({
      ...valid,
      stage: 'closed',
      isClosed: true,
      isVoided: true,
      outcome: 'rejected',
      communicationStatus: 'rejected',
    }).success).toBe(false);
  });
});
