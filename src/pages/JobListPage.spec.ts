import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { makeApplication, makeEvent } from '../domain/job-memory/testFixtures';
import { projectApplication } from '../domain/job-memory';
import JobListPage from './JobListPage.vue';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  summaries: vi.fn(),
}));

vi.mock('../config/features', () => ({
  features: { jobMemoryV2Enabled: true },
}));
vi.mock('../api/jobsApi', () => ({ jobsApi: { list: mocks.list } }));
vi.mock('../api/jobMemoryApi', () => ({ jobMemoryApi: { getJobSummaries: mocks.summaries } }));

function job(): JobRecord {
  return {
    id: 'job-1', createdAt: 1, updatedAt: 2, company: '摘要测试公司', role: '前端', city: '苏州',
    salaryRange: '', jdText: '', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: null, matchScore: '', companyInput: emptyCompanyInput(),
    companyAssessment: null, opportunityAnalysis: null, communicationStatus: 'not_contacted',
    followupCount: 0,
  };
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/jobs', name: 'jobs', component: JobListPage },
      { path: '/jobs/new', name: 'job-new', component: { template: '<p>new</p>' } },
      { path: '/jobs/:jobId', name: 'job-detail', component: { template: '<p>detail</p>' } },
    ],
  });
  await router.push('/jobs');
  await router.isReady();
  return mount(JobListPage, { global: { plugins: [router] } });
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.summaries.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('JobList B4 求职流程摘要', () => {
  it('导入建议分类使用中文映射，不回显 wait_review code', async () => {
    const imported = job();
    imported.importStatus = 'imported_draft';
    imported.reviewStatus = 'pending_review';
    imported.importedDraft = {
      recommendedCategory: 'wait_review', reason: '需要核对', confidence: 0.5,
      riskFlags: [], warnings: [], missingFields: [], rawText: '',
    };
    mocks.list.mockResolvedValue([imported]);
    mocks.summaries.mockResolvedValue([{
      job: imported, applicationCount: 0, activeApplicationCount: 0,
      defaultApplication: null, defaultResumeVersionName: null, projectionDiagnostics: [],
    }]);
    const wrapper = await mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('待人工确认');
    expect(wrapper.text()).not.toContain('wait_review');
    wrapper.unmount();
  });

  it('岗位与摘要各请求一次，展示零流程事实且两条读取都收到 AbortSignal', async () => {
    mocks.list.mockResolvedValue([job()]);
    mocks.summaries.mockResolvedValue([{
      job: job(), applicationCount: 0, activeApplicationCount: 0,
      defaultApplication: null, defaultResumeVersionName: null, projectionDiagnostics: [],
    }]);
    const wrapper = await mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('摘要测试公司');
    expect(wrapper.get('[data-application-summary]').text()).toContain('未记录流程');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.summaries).toHaveBeenCalledTimes(1);
    expect(mocks.list.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(mocks.summaries.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
    wrapper.unmount();
  });

  it('摘要失败不清空基础岗位，提供独立错误和摘要重试', async () => {
    mocks.list.mockResolvedValue([job()]);
    mocks.summaries.mockRejectedValueOnce(new Error('summary down')).mockResolvedValueOnce([{
      job: job(), applicationCount: 0, activeApplicationCount: 0,
      defaultApplication: null, defaultResumeVersionName: null, projectionDiagnostics: [],
    }]);
    const wrapper = await mountPage();
    await flushPromises();
    expect(wrapper.text()).toContain('摘要测试公司');
    expect(wrapper.text()).toContain('求职流程摘要读取失败');
    await wrapper.get('.banner-error .link-btn').trigger('click');
    await flushPromises();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.summaries).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[data-application-summary]').text()).toContain('未记录流程');
    wrapper.unmount();
  });

  it('卸载时同时 abort 岗位与摘要读取，迟到结果不能继续提交', async () => {
    let jobsSignal: AbortSignal | undefined;
    let summariesSignal: AbortSignal | undefined;
    mocks.list.mockImplementation((options) => {
      jobsSignal = options.signal;
      return new Promise(() => undefined);
    });
    mocks.summaries.mockImplementation((options) => {
      summariesSignal = options.signal;
      return new Promise(() => undefined);
    });
    const wrapper = await mountPage();
    await Promise.resolve();
    wrapper.unmount();
    expect(jobsSignal?.aborted).toBe(true);
    expect(summariesSignal?.aborted).toBe(true);
  });

  it('v2 列表决策与状态读取 default ApplicationProjection，不读取 Job legacy', async () => {
    const legacyRejected = job();
    legacyRejected.communicationStatus = 'rejected';
    legacyRejected.followupCount = 9;
    const record = makeApplication({ id: 'app-1', jobId: legacyRejected.id });
    const events = [makeEvent('hr_replied', { applicationId: record.id })];
    const projection = projectApplication(record, events);
    mocks.list.mockResolvedValue([legacyRejected]);
    mocks.summaries.mockResolvedValue([{
      job: legacyRejected, applicationCount: 1, activeApplicationCount: 1,
      defaultApplication: { record, projection }, defaultResumeVersionName: null,
      projectionDiagnostics: [],
    }]);
    const wrapper = await mountPage();
    await flushPromises();
    expect(wrapper.get('.ac-status').text()).toBe('已回复');
    expect(wrapper.get('.ac-badge.action').text()).toBe('继续沟通');
    expect(wrapper.text()).not.toContain('已结束');
    expect(wrapper.get('[data-application-summary]').text()).toContain('沟通中');
    for (const raw of [
      'stage', 'outcome', 'communicationStatus', 'followUpCount', 'nextAllowedFollowUpAt',
      'lastMeaningfulEventAt', 'projectionStatus', 'direct_employer', 'not_contacted',
      'application_created', 'sourceConfidence', 'evidenceLevel', 'timePrecision', 'wait_review',
    ]) {
      expect(wrapper.text()).not.toContain(raw);
    }
    wrapper.unmount();
  });

  it('v2 有流程但 default projection 不可用时不回退 legacy 生成正常建议', async () => {
    const legacyReplied = job();
    legacyReplied.communicationStatus = 'replied';
    mocks.list.mockResolvedValue([legacyReplied]);
    mocks.summaries.mockResolvedValue([{
      job: legacyReplied, applicationCount: 1, activeApplicationCount: 1,
      defaultApplication: null, defaultResumeVersionName: null,
      projectionDiagnostics: [{
        applicationId: 'invalid-app', projectionStatus: 'invalid', warnings: [],
        errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: 'broken' }],
      }],
    }]);
    const wrapper = await mountPage();
    await flushPromises();
    expect(wrapper.get('.ac-status').text()).toBe('流程状态不可用');
    expect(wrapper.get('.ac-badge.action').text()).toBe('先人工确认');
    expect(wrapper.text()).not.toContain('继续沟通');
    wrapper.unmount();
  });
});
