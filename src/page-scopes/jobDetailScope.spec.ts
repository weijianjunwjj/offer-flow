import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { scopeRegistry } from 'vue-page-scope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { injectJobDetailScope, useJobDetailScope } from './jobDetailScope';
import { isJobDetailBundleV2, type JobDetailApiPorts } from './jobDetailTypes';
import JobBasicInfoSection from '../pages/job-detail/JobBasicInfoSection.vue';
import JdInputSection from '../pages/job-detail/JdInputSection.vue';
import ImportReviewSection from '../pages/job-detail/ImportReviewSection.vue';
import CommunicationSection from '../pages/job-detail/CommunicationSection.vue';
import JobDecisionSection from '../pages/job-detail/JobDecisionSection.vue';
import ApplicationSection from '../pages/job-detail/ApplicationSection.vue';
import FeedbackTimelineSection from '../pages/job-detail/FeedbackTimelineSection.vue';
import { makeApplication, makeEvent } from '../domain/job-memory/testFixtures';
import { projectApplication } from '../domain/job-memory';
import { createEmptyEventDraft, fingerprintEventDrafts } from '../pages/job-detail/feedbackTimelineModel';
import { ApplicationApiError } from '../api/jobMemoryApi';

function makeJob(id: string, updatedAt = 1): JobRecord {
  return {
    id,
    createdAt: 1,
    updatedAt,
    company: `公司-${id}`,
    role: `岗位-${id}`,
    city: '苏州',
    salaryRange: '20K',
    jdText: 'JD',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: null,
    matchScore: '',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'not_contacted',
    followupCount: 0,
  };
}

function apiFor(jobId: string): JobDetailApiPorts {
  const job = makeJob(jobId);
  return {
    jobs: {
      get: vi.fn().mockResolvedValue(job),
      list: vi.fn().mockResolvedValue([job]),
      patch: vi.fn().mockImplementation(async (_id, patch) => ({ ...job, ...patch, updatedAt: 2 })),
    },
    profile: { get: vi.fn().mockResolvedValue(null) },
  };
}

const InjectedSection = defineComponent({
  setup() {
    const scope = injectJobDetailScope();
    return () => h('span', { 'data-section-scope': '' }, scope?.$id ?? 'missing');
  },
});

const Owner = defineComponent({
  props: { jobId: { type: String, required: true } },
  setup(props) {
    const scope = useJobDetailScope({ jobId: props.jobId, api: apiFor(props.jobId) });
    return () => h('div', [h(InjectedSection), h('b', scope.$source.bundle?.job.id ?? 'loading')]);
  },
});

function mountOwnerForApi(api: JobDetailApiPorts) {
  const ApiOwner = defineComponent({
    setup() {
      const scope = useJobDetailScope({
        jobId: 'A', api, runtimeEnabled: true, jobMemoryV2Enabled: true,
      });
      return () => h('b', scope.$source.bundle?.job.id ?? 'loading');
    },
  });
  return mount(ApiOwner);
}

afterEach(() => {
  scopeRegistry.get('job-detail')?.$destroy();
});

describe('岗位详情 Page Scope', () => {
  it('owner 与 Section 注入同一 Scope，并由 acceptBundle 建立 source/draft', async () => {
    const wrapper = mount(Owner, { props: { jobId: 'A' } });
    await flushPromises();
    const scope = scopeRegistry.get('job-detail');
    expect(scope).toBeTruthy();
    expect(wrapper.get('[data-section-scope]').text()).toBe('job-detail');
    expect(scope?.$source.bundle.job.id).toBe('A');
    expect(scope?.$state.jobDraft.company).toBe('公司-A');
    expect(scope?.$state.baselineFingerprint).not.toBe('');
    scope!.jobDraft.company = '未保存公司';
    expect((scope as ReturnType<typeof useJobDetailScope>).isDirty).toBe(true);
    wrapper.unmount();
    expect(scopeRegistry.has('job-detail')).toBe(false);
  });

  it('五个稳定 Section 都注入 owner 的同一实例', async () => {
    const SectionOwner = defineComponent({
      setup() {
        useJobDetailScope({ jobId: 'A', api: apiFor('A') });
        const props = { scopeRequired: true };
        return () => h('div', [
          h(JobBasicInfoSection, props), h(JdInputSection, props), h(ImportReviewSection, props),
          h(CommunicationSection, props), h(JobDecisionSection, props),
        ]);
      },
    });
    const wrapper = mount(SectionOwner);
    await flushPromises();
    const sections = wrapper.findAll('[data-scope-id="job-detail"]');
    expect(sections).toHaveLength(5);
    wrapper.unmount();
    expect(scopeRegistry.size).toBe(0);
  });

  it('v2 ApplicationSection 作为第六个边界只注入现有 owner，不创建第二个 Scope', async () => {
    const job = makeJob('A');
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [] },
        memory: { applications: [], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const SectionOwner = defineComponent({
      setup() {
        useJobDetailScope({ jobId: 'A', api, runtimeEnabled: true, jobMemoryV2Enabled: true });
        return () => h(ApplicationSection, { scopeRequired: true });
      },
    });
    const wrapper = mount(SectionOwner);
    await flushPromises();
    expect(wrapper.get('[data-scope-id="job-detail"]')).toBeTruthy();
    expect(scopeRegistry.size).toBe(1);
    wrapper.unmount();
  });

  it('v2 FeedbackTimelineSection 作为第七个边界复用 owner，capability=true 才消费 Bundle', async () => {
    const job = makeJob('A');
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job], applicationSummariesByJob: { A: [] },
        memory: { applications: [], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const SectionOwner = defineComponent({
      setup() {
        useJobDetailScope({ jobId: 'A', api, runtimeEnabled: true, jobMemoryV2Enabled: true });
        return () => h(FeedbackTimelineSection, { scopeRequired: true });
      },
    });
    const wrapper = mount(SectionOwner);
    await flushPromises();
    expect(wrapper.get('[data-feedback-timeline]').attributes('data-scope-id')).toBe('job-detail');
    expect(scopeRegistry.size).toBe(1);
    wrapper.unmount();
  });

  it('写成功后原子替换 memory，保留合法手动选择，作废所选项后按共享规则重选', async () => {
    const firstRecord = makeApplication({ id: 'first', jobId: 'A', createdAt: 1, updatedAt: 1 });
    const secondRecord = makeApplication({ id: 'second', jobId: 'A', createdAt: 2, updatedAt: 2 });
    const firstEvents = [makeEvent('application_created', { applicationId: 'first', createdAt: 1 })];
    const secondEvents = [makeEvent('application_created', { applicationId: 'second', createdAt: 2 })];
    const first = { record: firstRecord, events: firstEvents, projection: projectApplication(firstRecord, firstEvents) };
    const second = { record: secondRecord, events: secondEvents, projection: projectApplication(secondRecord, secondEvents) };
    const job = makeJob('A');
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [{ record: first.record, projection: first.projection }, { record: second.record, projection: second.projection }] },
        memory: { applications: [first, second], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    detailScope.selectedApplicationId = 'first';
    detailScope.eventDraft = createEmptyEventDraft('boss');
    detailScope.eventDraft.note = '属于 first';
    detailScope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
    const voidedRecord = { ...firstRecord, voidedAt: 3, voidReason: '误录', updatedAt: 3, rowVersion: 2 };
    const voidedFirst = {
      ...first,
      record: voidedRecord,
      projection: projectApplication(voidedRecord, firstEvents),
    };
    detailScope.acceptMemoryBundle({
      applications: [voidedFirst, second], resumeVersions: [], activeResumeVersionId: null,
    });
    expect(
      isJobDetailBundleV2(detailScope.$source.bundle!)
        ? detailScope.$source.bundle.memory.applications.map(({ record }) => record.id)
        : [],
    ).toEqual(['first', 'second']);
    expect(detailScope.selectedApplicationId).toBe('second');
    expect(detailScope.eventDraft).toBeNull();
    wrapper.unmount();
  });

  it('Event 写成功使用服务端完整 memory 原子替换，关闭后仍保持选择并同步当前 Job 摘要', async () => {
    const record = makeApplication({ id: 'first', jobId: 'A', createdAt: 1, updatedAt: 1 });
    const created = makeEvent('application_created', { applicationId: 'first', createdAt: 1, eventAt: 1 });
    const initial = { record, events: [created], projection: projectApplication(record, [created]) };
    const rejected = makeEvent('rejected', {
      id: 'rejected', applicationId: 'first', idempotencyKey: 'event-key', createdAt: 2, eventAt: 2,
    });
    const nextRecord = { ...record, rowVersion: 2, updatedAt: 2 };
    const next = {
      record: nextRecord,
      events: [created, rejected],
      projection: projectApplication(nextRecord, [created, rejected]),
    };
    const job = makeJob('A');
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [{ record, projection: initial.projection }] },
        memory: { applications: [initial], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn().mockResolvedValue({
        applications: [next], resumeVersions: [], activeResumeVersionId: null,
      }),
      voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    detailScope.eventDraft = createEmptyEventDraft('boss');
    detailScope.eventDraft.note = '用户确认';
    detailScope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
    await detailScope.appendFeedbackEvent('first', {
      idempotencyKey: 'event-key', expectedApplicationVersion: 1, eventType: 'rejected', eventAt: 2,
      timePrecision: 'exact', actor: 'hr', sourceConfidence: 'exact', evidenceLevel: 'strong',
      channel: 'boss', note: null, reasonCode: 'skills', payload: {},
    });
    expect(detailScope.selectedApplicationId).toBe('first');
    expect(detailScope.eventDraft).toBeNull();
    expect(detailScope.actionStatus.applicationWrite).toBe('done');
    if (!isJobDetailBundleV2(detailScope.$source.bundle!)) throw new Error('expected v2');
    expect(detailScope.$source.bundle.memory).toEqual({
      applications: [next], resumeVersions: [], activeResumeVersionId: null,
    });
    expect(detailScope.$source.bundle.applicationSummariesByJob.A?.[0]?.projection.outcome).toBe('rejected');
    wrapper.unmount();
  });

  it('VERSION_CONFLICT reload 后保留 Event dirty 草稿和同一幂等键', async () => {
    const record = makeApplication({ id: 'first', jobId: 'A' });
    const events = [makeEvent('application_created', { applicationId: 'first' })];
    const current = { record, events, projection: projectApplication(record, events) };
    const job = makeJob('A');
    const bundle = {
      jobId: 'A', job, profile: null, allJobs: [job],
      applicationSummariesByJob: { A: [{ record, projection: current.projection }] },
      memory: { applications: [current], resumeVersions: [], activeResumeVersionId: null },
    };
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue(bundle),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn().mockRejectedValue(new ApplicationApiError(
        'VERSION_CONFLICT', '自由文本不参与分支', 409, undefined, 2,
      )),
      voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    const draft = createEmptyEventDraft('boss');
    draft.note = '保留这段原因';
    detailScope.eventDraft = draft;
    detailScope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
    const key = draft.idempotencyKey;
    await expect(detailScope.appendFeedbackEvent('first', {
      idempotencyKey: key, expectedApplicationVersion: 1, eventType: 'applied', eventAt: null,
      timePrecision: 'unknown', actor: 'user', sourceConfidence: 'recalled', evidenceLevel: 'weak',
      channel: 'boss', note: '保留这段原因', reasonCode: null, payload: {},
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(api.jobMemory.getJobDetailBundle).toHaveBeenCalledTimes(2);
    expect(detailScope.eventDraft).toMatchObject({ idempotencyKey: key, note: '保留这段原因' });
    expect(detailScope.isEventDirty).toBe(true);
    wrapper.unmount();
  });

  it('owner 销毁后迟到 Event 写响应不得提交到已销毁 Scope', async () => {
    const record = makeApplication({ id: 'first', jobId: 'A' });
    const events = [makeEvent('application_created', { applicationId: 'first' })];
    const current = { record, events, projection: projectApplication(record, events) };
    const job = makeJob('A');
    let resolveWrite!: (value: unknown) => void;
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [{ record, projection: current.projection }] },
        memory: { applications: [current], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn().mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve; })),
      voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    const write = detailScope.appendFeedbackEvent('first', {
      idempotencyKey: 'late', expectedApplicationVersion: 1, eventType: 'applied', eventAt: null,
      timePrecision: 'unknown', actor: 'user', sourceConfidence: 'exact', evidenceLevel: 'medium',
      channel: 'boss', note: null, reasonCode: null, payload: {},
    });
    wrapper.unmount();
    const changedRecord = { ...record, rowVersion: 2 };
    resolveWrite({
      applications: [{
        record: changedRecord, events, projection: projectApplication(changedRecord, events),
      }],
      resumeVersions: [], activeResumeVersionId: null,
    });
    await write;
    expect(detailScope.$disposed).toBe(true);
    expect(
      detailScope.$source.bundle && isJobDetailBundleV2(detailScope.$source.bundle)
        ? detailScope.$source.bundle.memory.applications[0]?.record.rowVersion
        : null,
    ).toBe(1);
    expect(scopeRegistry.size).toBe(0);
  });

  it('acceptUpdatedJob 同步 job 与 allJobs，且非确认写不清理分析草稿', async () => {
    const wrapper = mount(Owner, { props: { jobId: 'A' } });
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail');
    detailScope?.$patch({ analysisDraft: { rawText: '未确认', dirty: true, streamRunId: 1, error: '' } });
    const updated = makeJob('A', 9);
    updated.company = '新公司';
    (detailScope as ReturnType<typeof useJobDetailScope>).acceptUpdatedJob(updated);
    expect(detailScope?.$source.bundle.job.company).toBe('新公司');
    expect(detailScope?.$source.bundle.allJobs.find((job: JobRecord) => job.id === 'A')?.company).toBe('新公司');
    expect(detailScope?.$state.jobDraft.company).toBe('新公司');
    expect(detailScope?.$state.analysisDraft.rawText).toBe('未确认');
    wrapper.unmount();
  });

  it('decision getters 随 selected Application 和服务端 Event Bundle 自动重算，不读取 Job legacy', async () => {
    const repliedRecord = makeApplication({ id: 'replied-app', jobId: 'A', createdAt: 1 });
    const repliedEvents = [makeEvent('hr_replied', {
      id: 'replied-event', applicationId: repliedRecord.id, idempotencyKey: 'replied-key', createdAt: 1,
    })];
    const coldRecord = makeApplication({ id: 'cold-app', jobId: 'A', createdAt: 2 });
    const coldEvents = [makeEvent('greeting_sent', {
      id: 'cold-event', applicationId: coldRecord.id, idempotencyKey: 'cold-key', createdAt: 2,
    })];
    const replied = { record: repliedRecord, events: repliedEvents, projection: projectApplication(repliedRecord, repliedEvents) };
    const cold = { record: coldRecord, events: coldEvents, projection: projectApplication(coldRecord, coldEvents) };
    const job = makeJob('A');
    job.communicationStatus = 'rejected';
    job.followupCount = 99;
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [replied, cold].map(({ record, projection }) => ({ record, projection })) },
        memory: { applications: [replied, cold], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const scope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    expect(scope.decisionFactsSource).toBe('application_projection');
    expect(scope.decisionFacts?.application?.applicationId).toBe('cold-app');
    expect(scope.decisionResult?.nextAction).toBe('follow_up_once');

    scope.selectedApplicationId = 'replied-app';
    await nextTick();
    expect(scope.decisionFacts?.application?.applicationId).toBe('replied-app');
    expect(scope.decisionResult?.nextAction).toBe('continue_conversation');

    const rejectedEvent = makeEvent('rejected', {
      id: 'rejected-event', applicationId: repliedRecord.id, idempotencyKey: 'rejected-key', createdAt: 3,
    });
    const rejectedEvents = [...repliedEvents, rejectedEvent];
    const rejected = {
      record: { ...repliedRecord, rowVersion: 2 }, rejectedEvents,
      events: rejectedEvents,
      projection: projectApplication({ ...repliedRecord, rowVersion: 2 }, rejectedEvents),
    };
    scope.acceptMemoryBundle({
      applications: [{ record: rejected.record, events: rejected.events, projection: rejected.projection }, cold],
      resumeVersions: [], activeResumeVersionId: null,
    });
    expect(scope.decisionResult?.nextAction).toBeNull();
    expect(scope.decisionResult?.flowNotice).toContain('拒绝');
    wrapper.unmount();
  });

  it('v2 零流程区分只读 legacy 与 opportunity-only，invalid 不回退；v1 保持 legacy', async () => {
    const legacyJob = makeJob('A');
    legacyJob.communicationStatus = 'replied';
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job: legacyJob, profile: null, allJobs: [legacyJob],
        applicationSummariesByJob: { A: [] },
        memory: { applications: [], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const scope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    expect(scope.decisionFactsSource).toBe('legacy_job_fallback');
    expect(scope.decisionCompatibilityWarning).toContain('历史兼容状态');
    wrapper.unmount();

    const opportunityJob = makeJob('A');
    api.jobMemory.getJobDetailBundle = vi.fn().mockResolvedValue({
      jobId: 'A', job: opportunityJob, profile: null, allJobs: [opportunityJob],
      applicationSummariesByJob: { A: [] },
      memory: { applications: [], resumeVersions: [], activeResumeVersionId: null },
    });
    const opportunityWrapper = mountOwnerForApi(api);
    await flushPromises();
    const opportunityScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    expect(opportunityScope.decisionFactsSource).toBe('opportunity_only');
    expect(opportunityScope.decisionCompatibilityWarning).toBeNull();
    opportunityWrapper.unmount();

    const invalidRecord = makeApplication({ id: 'invalid-app', jobId: 'A' });
    const invalidEvents = [makeEvent('hr_replied', { applicationId: invalidRecord.id })];
    const invalidProjection = {
      ...projectApplication(invalidRecord, invalidEvents), projectionStatus: 'invalid' as const,
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT' as const, message: 'broken' }],
    };
    legacyJob.communicationStatus = 'interviewing';
    api.jobMemory.getJobDetailBundle = vi.fn().mockResolvedValue({
      jobId: 'A', job: legacyJob, profile: null, allJobs: [legacyJob],
      applicationSummariesByJob: { A: [{ record: invalidRecord, projection: invalidProjection }] },
      memory: {
        applications: [{ record: invalidRecord, events: invalidEvents, projection: invalidProjection }],
        resumeVersions: [], activeResumeVersionId: null,
      },
    });
    const invalidWrapper = mountOwnerForApi(api);
    await flushPromises();
    const invalidScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    expect(invalidScope.decisionFactsSource).toBe('application_projection');
    expect(invalidScope.decisionResult?.nextAction).toBe('manual_review');
    invalidWrapper.unmount();

    const v1Wrapper = mount(Owner, { props: { jobId: 'A' } });
    await flushPromises();
    const v1Scope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    expect(v1Scope.decisionFactsSource).toBe('legacy_job_fallback');
    v1Wrapper.unmount();
  });

  it('v2 Scope 拒绝 legacy patch 和有 Application 时的 Job draft，岗位事实 PATCH 仍允许', async () => {
    const record = makeApplication({ id: 'app-1', jobId: 'A' });
    const events = [makeEvent('application_created', { applicationId: record.id })];
    const current = { record, events, projection: projectApplication(record, events) };
    const job = makeJob('A');
    const api = apiFor('A');
    api.jobMemory = {
      getJobDetailBundle: vi.fn().mockResolvedValue({
        jobId: 'A', job, profile: null, allJobs: [job],
        applicationSummariesByJob: { A: [{ record, projection: current.projection }] },
        memory: { applications: [current], resumeVersions: [], activeResumeVersionId: null },
      }),
      getJobSummaries: vi.fn(), createApplication: vi.fn(), updateApplication: vi.fn(), voidApplication: vi.fn(),
      appendFeedbackEvent: vi.fn(), voidFeedbackEvent: vi.fn(),
    };
    const wrapper = mountOwnerForApi(api);
    await flushPromises();
    const scope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    await expect(scope.updateCommunication({ communicationStatus: 'replied' })).rejects.toMatchObject({
      status: 422, body: { code: 'LEGACY_COMMUNICATION_WRITE_DISABLED' },
    });
    await expect(scope.updateCommunication({ draftMessageText: 'Job 旁路' })).rejects.toMatchObject({
      status: 422,
    });
    expect(api.jobs.patch).not.toHaveBeenCalled();
    await scope.updateCommunication({ highValueSignal: true });
    expect(api.jobs.patch).toHaveBeenCalledWith('A', { highValueSignal: true });
    wrapper.unmount();
  });

  it('真实 keyed 组件 A→B→C 不重叠注册，最终只保留当前 owner', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Host = defineComponent({
      props: { jobId: { type: String, required: true } },
      setup(props) {
        return () => h(Owner, { key: props.jobId, jobId: props.jobId });
      },
    });
    const wrapper = mount(Host, { props: { jobId: 'A' } });
    await flushPromises();
    const firstScope = scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>;
    firstScope.eventDraft = createEmptyEventDraft('boss');
    firstScope.eventDraft.note = '只属于 A';
    for (const jobId of ['B', 'C']) {
      await wrapper.setProps({ jobId });
      await nextTick();
      await flushPromises();
      expect(scopeRegistry.size).toBe(1);
      expect(scopeRegistry.get('job-detail')?.$source.bundle.job.id).toBe(jobId);
      expect((scopeRegistry.get('job-detail') as ReturnType<typeof useJobDetailScope>).eventDraft).toBeNull();
    }
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warningSpy.mock.calls.flat().join(' ')).not.toContain('already exists');
    wrapper.unmount();
    expect(scopeRegistry.size).toBe(0);
  });
});
