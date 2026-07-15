import { describe, expect, it } from 'vitest';
import { makeApplication, makeEvent } from '../job-memory/testFixtures';
import type { JobRecord } from '../../storage/types';
import { aggregateFunnel } from './aggregate';
import type { FunnelSourceApplication } from './types';

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    createdAt: 0,
    updatedAt: 0,
    company: '示例公司',
    role: '后端工程师',
    city: '上海',
    salaryRange: '',
    jdText: '',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: null,
    matchScore: '',
    companyInput: { name: '示例公司' },
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'not_contacted',
    followupCount: 0,
    ...overrides,
  } as JobRecord;
}

describe('aggregateFunnel', () => {
  it('按城市/岗位族/渠道/简历版本分组，统计已确认投递流程数', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({
          id: 'app-1',
          channel: 'boss',
          cityContext: { jobCity: '上海', marketCity: null, workMode: 'unknown' },
          resumeVersionId: 'resume-1',
        }),
        job: makeJob({ role: '后端工程师', city: '上海' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-1' }),
          makeEvent('applied', { applicationId: 'app-1' }),
          makeEvent('hr_replied', { applicationId: 'app-1' }),
        ],
      },
      {
        application: makeApplication({
          id: 'app-2',
          channel: 'boss',
          cityContext: { jobCity: '上海', marketCity: null, workMode: 'unknown' },
          resumeVersionId: 'resume-1',
        }),
        job: makeJob({ role: '后端工程师', city: '上海' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-2' }),
          makeEvent('applied', { applicationId: 'app-2' }),
          makeEvent('rejected', { applicationId: 'app-2', reasonCode: 'skills' }),
        ],
      },
    ];

    const result = aggregateFunnel(sources);

    expect(result.groups).toHaveLength(1);
    const [group] = result.groups;
    expect(group.key).toEqual({
      city: '上海',
      roleFamily: '后端工程师',
      channel: 'boss',
      resumeVersionId: 'resume-1',
      windowLabel: null,
    });
    expect(group.processCount).toBe(2);
    expect(group.validReplyCount).toBe(2); // hr_replied + rejected 都算有效回复
    expect(group.outcomeCounts.rejected).toBe(1);
    expect(group.inProgressCount).toBe(1);
    expect(result.totalProcessCount).toBe(2);
  });

  it('未投递的历史记录（无 Application）从不进入分母', () => {
    // 未投递草稿在补录确认时压根不会 materialize 成 Application，
    // 因此不会出现在 source 列表中；这里验证空 source 时分母为 0。
    const result = aggregateFunnel([]);
    expect(result.totalProcessCount).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  it('已作废的 Application 被排除，不计入任何分组', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-voided', voidedAt: 500, voidReason: '重复录入' }),
        job: makeJob(),
        events: [makeEvent('application_created', { applicationId: 'app-voided' })],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.totalProcessCount).toBe(0);
    expect(result.exclusions.voidedApplicationCount).toBe(1);
  });

  it('用户主动退出不计为招聘方拒绝，岗位关闭单独计数', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-withdrew' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-withdrew' }),
          makeEvent('applied', { applicationId: 'app-withdrew' }),
          makeEvent('user_withdrew', { applicationId: 'app-withdrew' }),
        ],
      },
      {
        application: makeApplication({ id: 'app-closed' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-closed' }),
          makeEvent('applied', { applicationId: 'app-closed' }),
          makeEvent('position_closed', { applicationId: 'app-closed' }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    const [group] = result.groups;
    expect(group.outcomeCounts.rejected).toBe(0);
    expect(group.outcomeCounts.userWithdrew).toBe(1);
    expect(group.outcomeCounts.positionClosed).toBe(1);
  });

  it('按查询条件过滤（城市/渠道/时间窗）', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({
          id: 'app-sh',
          channel: 'boss',
          cityContext: { jobCity: '上海', marketCity: null, workMode: 'unknown' },
          createdAt: 100,
        }),
        job: makeJob({ city: '上海' }),
        events: [makeEvent('application_created', { applicationId: 'app-sh' })],
      },
      {
        application: makeApplication({
          id: 'app-bj',
          channel: 'referral',
          cityContext: { jobCity: '北京', marketCity: null, workMode: 'unknown' },
          createdAt: 200,
        }),
        job: makeJob({ city: '北京' }),
        events: [makeEvent('application_created', { applicationId: 'app-bj' })],
      },
    ];
    const result = aggregateFunnel(sources, { city: '上海' });
    expect(result.totalProcessCount).toBe(1);
    expect(result.groups[0]?.key.city).toBe('上海');
  });

  it('回忆/推断来源事件占比计入 recalledDataShare', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-recalled' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-recalled', sourceConfidence: 'recalled' }),
          makeEvent('applied', { applicationId: 'app-recalled', sourceConfidence: 'recalled' }),
          makeEvent('hr_replied', { applicationId: 'app-recalled', sourceConfidence: 'exact' }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    const [group] = result.groups;
    expect(group.recalledDataShare).toBeCloseTo(2 / 3);
  });

  it('曾经推进到面试/Offer 阶段按历史最高阶段计数，不受后续关闭影响', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-interviewed' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-interviewed' }),
          makeEvent('applied', { applicationId: 'app-interviewed' }),
          makeEvent('interview_scheduled', { applicationId: 'app-interviewed' }),
          makeEvent('rejected', { applicationId: 'app-interviewed' }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    const [group] = result.groups;
    expect(group.reachedScreeningCount).toBe(1);
    expect(group.reachedInterviewingCount).toBe(1);
    expect(group.reachedOfferCount).toBe(0);
  });
});
