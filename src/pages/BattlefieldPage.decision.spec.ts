import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { makeApplication, makeEvent } from '../domain/job-memory/testFixtures';
import { projectApplication } from '../domain/job-memory';
import { deriveDecision, resolveDecisionOpportunityFacts } from '../decision';
import BattlefieldPage from './BattlefieldPage.vue';

const mocks = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock('../page-scopes/jobDetailScope', () => ({
  injectJobDetailScope: () => mocks.scope,
}));
vi.mock('./job-detail/JobBasicInfoSection.vue', () => ({ default: { template: '<section />' } }));
vi.mock('./job-detail/JdInputSection.vue', () => ({ default: { template: '<section />' } }));
vi.mock('./job-detail/ImportReviewSection.vue', () => ({ default: { template: '<section />' } }));
vi.mock('./job-detail/JobDecisionSection.vue', () => ({ default: { template: '<section />' } }));
vi.mock('./job-detail/ApplicationSection.vue', () => ({ default: { template: '<section />' } }));
vi.mock('./job-detail/FeedbackTimelineSection.vue', () => ({ default: { template: '<section />' } }));

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1', createdAt: 1, updatedAt: 1, company: '决策 UI 公司', role: '前端', city: '苏州',
    salaryRange: '', jdText: 'Vue', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: {
      jobType: '', keywords: '', techStackMatch: '', projectMatch: '', strengths: '', risks: '',
      resumeAdvice: '', interviewChecklist: '', applyAdvice: 'ok', greetingMessage: '',
    }, matchScore: '', companyInput: emptyCompanyInput(), companyAssessment: null,
    opportunityAnalysis: null, communicationStatus: 'not_contacted', followupCount: 0,
    ...overrides,
  };
}

function scopeFor(
  currentJob: JobRecord,
  v2: boolean,
  facts: ReturnType<typeof resolveDecisionOpportunityFacts>,
) {
  return {
    $id: 'job-detail', jobMemoryV2Enabled: v2,
    $source: { bundle: { jobId: currentJob.id, job: currentJob, profile: null, allJobs: [currentJob] } },
    decisionFacts: facts,
    decisionFactsSource: facts.source,
    decisionResult: deriveDecision(facts),
    decisionCompatibilityWarning: facts.source === 'legacy_job_fallback' && v2
      ? '历史兼容状态，尚未迁移为事件事实。旧数据只读，建议建立 Application。'
      : null,
    selectedApplicationMemory: null,
    isApplicationDirty: false, isEventDirty: false, actionStatus: {},
    acceptUpdatedJob: vi.fn(), setDecisionJobPreview: vi.fn(),
    saveGreeting: vi.fn(), submitImportReview: vi.fn(), updateCommunication: vi.fn(),
    saveMatchScore: vi.fn(), confirmAnalysis: vi.fn(), saveJobDraft: vi.fn(),
  };
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/jobs/:jobId', name: 'job-detail', component: BattlefieldPage }],
  });
  await router.push('/jobs/job-1');
  await router.isReady();
  return mount(BattlefieldPage, {
    props: { jobId: 'job-1', scopeRequired: true },
    global: {
      plugins: [router],
      stubs: { NDatePicker: true, NSelect: true, NInput: true },
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Battlefield B6 决策与沟通 UI', () => {
  it('v2 Application 显示事件投影来源并完全隐藏 legacy 编辑器和 Job 草稿', async () => {
    const currentJob = job({ communicationStatus: 'rejected', followupCount: 9 });
    const record = makeApplication({ id: 'app-1', jobId: currentJob.id });
    const events = [makeEvent('hr_replied', { applicationId: record.id })];
    const current = { record, events, projection: projectApplication(record, events) };
    const facts = resolveDecisionOpportunityFacts({
      job: currentJob, selectedApplication: current, defaultApplication: current,
      availableApplications: [current], jobMemoryV2Enabled: true,
    });
    mocks.scope = scopeFor(currentJob, true, facts);
    const wrapper = await mountPage();
    expect(wrapper.get('.decision-source').attributes('data-source')).toBe('application_projection');
    expect(wrapper.text()).toContain('决策依据：当前求职流程的事件投影');
    expect(wrapper.text()).toContain('继续沟通');
    expect(wrapper.find('.status-options').exists()).toBe(false);
    expect(wrapper.find('.opportunity-draft-card').exists()).toBe(false);
    expect(wrapper.text()).toContain('话术草稿请在当前求职流程中维护');
    expect(wrapper.text()).toContain('沟通状态：已回复');
    for (const raw of [
      'app-1', 'stage', 'outcome', 'communicationStatus', 'followUpCount',
      'nextAllowedFollowUpAt', 'lastMeaningfulEventAt', 'projectionStatus', 'direct_employer',
      'not_contacted', 'application_created', 'sourceConfidence', 'evidenceLevel', 'timePrecision',
    ]) {
      expect(wrapper.text()).not.toContain(raw);
    }
    wrapper.unmount();
  });

  it('v2 legacy fallback 只读展示，岗位级草稿不写流程事实', async () => {
    const currentJob = job({ communicationStatus: 'replied', lastCommunicationNote: '历史记录' });
    const facts = resolveDecisionOpportunityFacts({
      job: currentJob, selectedApplication: null, defaultApplication: null,
      jobMemoryV2Enabled: true,
    });
    mocks.scope = scopeFor(currentJob, true, facts);
    const wrapper = await mountPage();
    expect(wrapper.get('.decision-source').attributes('data-source')).toBe('legacy_job_fallback');
    expect(wrapper.text()).toContain('岗位历史沟通数据（只读兼容）');
    expect(wrapper.find('.status-options').exists()).toBe(false);
    expect(wrapper.get('.opportunity-draft-card').text()).toContain('不会创建求职流程、追加反馈事实或改变沟通状态');
    wrapper.unmount();
  });

  it('v2 opportunity-only 明确无流程，v1 继续展示旧沟通编辑器', async () => {
    const currentJob = job();
    const opportunity = resolveDecisionOpportunityFacts({
      job: currentJob, selectedApplication: null, defaultApplication: null,
      jobMemoryV2Enabled: true,
    });
    mocks.scope = scopeFor(currentJob, true, opportunity);
    const v2Wrapper = await mountPage();
    expect(v2Wrapper.get('.decision-source').attributes('data-source')).toBe('opportunity_only');
    expect(v2Wrapper.text()).toContain('尚无已投递或招聘流程事实');
    expect(v2Wrapper.find('.status-options').exists()).toBe(false);
    v2Wrapper.unmount();

    const legacy = resolveDecisionOpportunityFacts({
      job: currentJob, selectedApplication: null, defaultApplication: null,
      jobMemoryV2Enabled: false,
    });
    mocks.scope = scopeFor(currentJob, false, legacy);
    const v1Wrapper = await mountPage();
    expect(v1Wrapper.find('.decision-source').exists()).toBe(false);
    expect(v1Wrapper.find('.status-options').exists()).toBe(true);
    expect(v1Wrapper.text()).toContain('保存跟进事实');
    v1Wrapper.unmount();
  });
});
