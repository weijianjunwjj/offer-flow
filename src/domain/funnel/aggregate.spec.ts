import { describe, expect, it } from 'vitest';
import { makeApplication, makeEvent } from '../job-memory/testFixtures';
import type { JobRecord } from '../../storage/types';
import { aggregateFunnel, listFunnelDetailRows } from './aggregate';
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
  it('默认不分组，返回全局总览', () => {
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

    expect(result.groups).toHaveLength(0);
    expect(result.totalProcessCount).toBe(2);
    const appliedStage = result.overview.stages[0];
    expect(appliedStage?.stage).toBe('applied');
    expect(appliedStage?.count).toBe(2);
    expect(appliedStage?.conversionFromPrevious).toBeNull();
    expect(appliedStage?.conversionFromApplied).toBe(1);
    const replyStage = result.overview.stages[1];
    expect(replyStage?.stage).toBe('valid_reply');
    expect(replyStage?.count).toBe(2); // hr_replied + rejected 都算有效回复
    expect(replyStage?.conversionFromPrevious).toBe(1);
    expect(result.overview.statusCounts.rejected_by_recruiter).toBe(1);
    expect(result.overview.statusCounts.in_progress).toBe(1);
  });

  it('未投递的历史记录（无 Application）从不进入分母', () => {
    // 未投递草稿在补录确认时压根不会 materialize 成 Application，
    // 因此不会出现在 source 列表中；这里验证空 source 时分母为 0。
    const result = aggregateFunnel([]);
    expect(result.totalProcessCount).toBe(0);
    expect(result.overview.confidence.totalAppliedCount).toBe(0);
    expect(result.overview.confidence.recalledOrInferredShare).toBeNull();
  });

  it('已作废的 Application 被排除，不计入统计', () => {
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
    expect(result.overview.statusCounts.rejected_by_recruiter).toBe(0);
    expect(result.overview.statusCounts.user_withdrew).toBe(1);
    expect(result.overview.statusCounts.position_closed).toBe(1);
  });

  it('按查询条件过滤（城市/渠道/时间窗），不影响分组维度选择', () => {
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
    const result = aggregateFunnel(sources, { city: '上海', groupBy: 'channel' });
    expect(result.totalProcessCount).toBe(1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key.channel).toBe('boss');
  });

  it('按城市分组时每组分别计算总览与两套转化率', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({
          id: 'app-sh-1',
          cityContext: { jobCity: '上海', marketCity: null, workMode: 'unknown' },
        }),
        job: makeJob({ city: '上海' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-sh-1' }),
          makeEvent('applied', { applicationId: 'app-sh-1' }),
        ],
      },
      {
        application: makeApplication({
          id: 'app-sh-2',
          cityContext: { jobCity: '上海', marketCity: null, workMode: 'unknown' },
        }),
        job: makeJob({ city: '上海' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-sh-2' }),
          makeEvent('applied', { applicationId: 'app-sh-2' }),
          makeEvent('hr_replied', { applicationId: 'app-sh-2' }),
        ],
      },
      {
        application: makeApplication({
          id: 'app-bj-1',
          cityContext: { jobCity: '北京', marketCity: null, workMode: 'unknown' },
        }),
        job: makeJob({ city: '北京' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-bj-1' }),
          makeEvent('applied', { applicationId: 'app-bj-1' }),
        ],
      },
    ];
    const result = aggregateFunnel(sources, { groupBy: 'city' });
    expect(result.groups).toHaveLength(2);
    const shGroup = result.groups.find((group) => group.key.city === '上海');
    expect(shGroup?.overview.stages[0]?.count).toBe(2);
    expect(shGroup?.overview.stages[1]?.count).toBe(1);
    expect(shGroup?.overview.stages[1]?.conversionFromApplied).toBe(0.5);
  });

  it('岗位族分组：AI 相关岗位优先归入 AI 应用工程，不被前端规则截走', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-ai' }),
        job: makeJob({ role: 'AI 前端工程师' }),
        events: [makeEvent('application_created', { applicationId: 'app-ai' })],
      },
      {
        application: makeApplication({ id: 'app-fe' }),
        job: makeJob({ role: '高级前端工程师' }),
        events: [makeEvent('application_created', { applicationId: 'app-fe' })],
      },
      {
        application: makeApplication({ id: 'app-fe-2' }),
        job: makeJob({ role: '前端工程师' }),
        events: [makeEvent('application_created', { applicationId: 'app-fe-2' })],
      },
    ];
    const result = aggregateFunnel(sources, { groupBy: 'jobFamily' });
    const aiGroup = result.groups.find((group) => group.key.jobFamily === 'ai_applications');
    const feGroup = result.groups.find((group) => group.key.jobFamily === 'frontend');
    expect(aiGroup?.overview.stages[0]?.count).toBe(1);
    // "高级前端工程师"与"前端工程师"归入同一岗位族（职级不区分岗位族）。
    expect(feGroup?.overview.stages[0]?.count).toBe(2);
  });

  it('回忆/推断来源事件计入可信度分级', () => {
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
      {
        application: makeApplication({ id: 'app-exact' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-exact', sourceConfidence: 'exact' }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.overview.confidence.counts.recalled).toBe(1);
    expect(result.overview.confidence.counts.exact).toBe(1);
    expect(result.overview.confidence.recalledOrInferredShare).toBeCloseTo(0.5);
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
    const resumeStage = result.overview.stages.find((stage) => stage.stage === 'resume_requested');
    const interviewStage = result.overview.stages.find((stage) => stage.stage === 'interview_scheduled');
    const offerStage = result.overview.stages.find((stage) => stage.stage === 'offer_received');
    // 面试安排及以上视为已自动到达索要简历/电话沟通阶段。
    expect(resumeStage?.count).toBe(1);
    expect(interviewStage?.count).toBe(1);
    expect(offerStage?.count).toBe(0);
    // 拒绝是最终事件，覆盖之前的面试推进，计入拒绝而非进行中。
    expect(result.overview.statusCounts.rejected_by_recruiter).toBe(1);
    expect(result.overview.statusCounts.in_progress).toBe(0);
  });

  it('无回复之后没有恢复事件计入沉默/停滞，不计为拒绝', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-stale' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-stale', eventAt: 1_000 }),
          makeEvent('applied', { applicationId: 'app-stale', eventAt: 1_000 }),
          makeEvent('no_response_recorded', { applicationId: 'app-stale', eventAt: 2_000 }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.overview.statusCounts.stale).toBe(1);
    expect(result.overview.statusCounts.rejected_by_recruiter).toBe(0);
    expect(result.overview.statusCounts.in_progress).toBe(0);
  });

  it('无回复之后又出现 HR 回复，恢复为进行中', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-recovered' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-recovered', eventAt: 1_000 }),
          makeEvent('applied', { applicationId: 'app-recovered', eventAt: 1_000 }),
          makeEvent('no_response_recorded', { applicationId: 'app-recovered', eventAt: 2_000 }),
          makeEvent('hr_replied', { applicationId: 'app-recovered', eventAt: 3_000 }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.overview.statusCounts.stale).toBe(0);
    expect(result.overview.statusCounts.in_progress).toBe(1);
  });

  it('招聘暂停/冻结之后没有恢复事件计入招聘暂停/冻结，不计为进行中或拒绝', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-paused' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-paused', eventAt: 1_000 }),
          makeEvent('applied', { applicationId: 'app-paused', eventAt: 1_000 }),
          makeEvent('recruitment_paused', { applicationId: 'app-paused', eventAt: 2_000 }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.overview.statusCounts.paused_frozen).toBe(1);
    expect(result.overview.statusCounts.in_progress).toBe(0);
    expect(result.overview.statusCounts.rejected_by_recruiter).toBe(0);
  });

  it('招聘暂停后 process_resumed 恢复进行中', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({ id: 'app-resumed' }),
        job: makeJob(),
        events: [
          makeEvent('application_created', { applicationId: 'app-resumed', eventAt: 1_000 }),
          makeEvent('applied', { applicationId: 'app-resumed', eventAt: 1_000 }),
          makeEvent('recruitment_paused', { applicationId: 'app-resumed', eventAt: 2_000 }),
          makeEvent('process_resumed', { applicationId: 'app-resumed', eventAt: 3_000 }),
        ],
      },
    ];
    const result = aggregateFunnel(sources);
    expect(result.overview.statusCounts.paused_frozen).toBe(0);
    expect(result.overview.statusCounts.in_progress).toBe(1);
  });

  it('零分母时转化率为 null（前端渲染为 —）', () => {
    const result = aggregateFunnel([]);
    for (const stage of result.overview.stages) {
      expect(stage.conversionFromApplied).toBeNull();
    }
    expect(result.overview.stages[1]?.conversionFromPrevious).toBeNull();
  });
});

describe('listFunnelDetailRows', () => {
  it('默认不暴露内部字段，只输出可展示的明细字段', () => {
    const sources: FunnelSourceApplication[] = [
      {
        application: makeApplication({
          id: 'app-detail',
          channel: 'boss',
          cityContext: { jobCity: '苏州', marketCity: null, workMode: 'unknown' },
        }),
        job: makeJob({ company: 'X 公司', role: 'AI 应用工程师', city: '苏州' }),
        events: [
          makeEvent('application_created', { applicationId: 'app-detail' }),
          makeEvent('applied', { applicationId: 'app-detail' }),
        ],
      },
    ];
    const rows = listFunnelDetailRows(sources);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      company: 'X 公司',
      role: 'AI 应用工程师',
      jobFamily: 'ai_applications',
      city: '苏州',
      channel: 'boss',
      highestReachedStage: 'applied',
      status: 'in_progress',
    });
  });
});
