import { injectPageScope, definePageScope, type PageScope } from 'vue-page-scope';
import type { RuntimeTaskMap } from 'vue-page-runtime';
import { ApiError } from '../api/client';
import { ApplicationApiError } from '../api/jobMemoryApi';
import {
  selectDefaultApplication,
  type ApplicationMemory,
  type ApplicationSummary,
  type JobMemoryBundle,
} from '../domain/job-memory';
import {
  deriveDecision,
  resolveDecisionOpportunityFacts,
  type DecisionFactsSource,
  type DecisionOpportunityFacts,
  type DerivedDecision,
} from '../decision';
import type { JobRecord } from '../storage';
import {
  fingerprintApplicationDrafts,
  reconcileSelectedApplicationId,
} from '../pages/job-detail/applicationSectionModel';
import { fingerprintEventDrafts } from '../pages/job-detail/feedbackTimelineModel';
import './registerPageRuntime';
import type {
  AcceptUpdatedJobOptions,
  ApplicationWriteActions,
  JobDetailBundle,
  JobDetailScopeInjection,
  JobDetailSource,
  JobDetailState,
  JobEditDraft,
  JobPatch,
  SaveGreetingInput,
} from './jobDetailTypes';
import { isJobDetailBundleV2 } from './jobDetailTypes';

interface LoadRuntime {
  generation: number;
  controller: AbortController | null;
  ownerToken: symbol;
}

interface JobDetailGetters {
  isDirty(): boolean;
  isApplicationDirty(): boolean;
  isEventDirty(): boolean;
  job(): JobRecord | null;
  selectedApplicationMemory(): ApplicationMemory | null;
  decisionFacts(): DecisionOpportunityFacts | null;
  decisionFactsSource(): DecisionFactsSource | null;
  decisionResult(): DerivedDecision | null;
  decisionCompatibilityWarning(): string | null;
}

interface JobDetailActions extends ApplicationWriteActions {
  acceptBundle(bundle: JobDetailBundle): void;
  acceptUpdatedJob(updatedJob: JobRecord, options?: AcceptUpdatedJobOptions): void;
  loadDirect(): Promise<void>;
  reloadJobBundle(): Promise<void>;
  patchJob(patch: JobPatch, options?: AcceptUpdatedJobOptions): Promise<JobRecord>;
  saveJobDraft(): Promise<JobRecord | null>;
  confirmAnalysis(patch: JobPatch): Promise<JobRecord>;
  submitImportReview(patch: JobPatch): Promise<JobRecord>;
  updateCommunication(patch: JobPatch): Promise<JobRecord>;
  saveMatchScore(matchScore: string): Promise<JobRecord>;
  saveGreeting(input: SaveGreetingInput): Promise<JobRecord>;
  appendOcrText(text: string): void;
  setDecisionJobPreview(job: JobRecord | null): void;
  discardDraftAndReload(): Promise<void>;
}

type JobDetailScopeHost = PageScope<
  JobDetailState,
  JobDetailSource,
  JobDetailGetters,
  JobDetailActions,
  JobDetailScopeInjection
>;

const loadRuntime = new WeakMap<object, LoadRuntime>();
const LEGACY_COMMUNICATION_PATCH_FIELDS = new Set<keyof JobRecord>([
  'communicationStatus', 'followupCount', 'lastGreetedAt', 'lastFollowupAt', 'lastCommunicationNote',
]);

function runtimeFor(scope: object): LoadRuntime {
  const current = loadRuntime.get(scope);
  if (current) return current;
  const created = {
    generation: 0,
    controller: null,
    ownerToken: Symbol('job-detail-owner'),
  };
  loadRuntime.set(scope, created);
  return created;
}

export async function fetchJobBundle(
  api: JobDetailScopeInjection['api'],
  jobId: string,
  signal: AbortSignal,
  jobMemoryV2Enabled = false,
): Promise<JobDetailBundle> {
  if (jobMemoryV2Enabled) {
    if (api.jobMemory === undefined) throw new Error('Job Memory v2 API 未配置');
    return api.jobMemory.getJobDetailBundle(jobId, { signal });
  }
  const [job, profile, allJobs] = await Promise.all([
    api.jobs.get(jobId, { signal }),
    api.profile.get({ signal }),
    api.jobs.list({ signal }),
  ]);
  return { jobId, job, profile, allJobs };
}

function clearTaskReadState(scope: JobDetailScopeHost): void {
  const runtime = runtimeFor(scope);
  runtime.generation += 1;
  runtime.controller?.abort();
  runtime.controller = null;
  scope.$source.bundle = null;
  scope.jobDraft = null;
  scope.baselineFingerprint = '';
  scope.loadError = null;
}

async function executeBundleLoad(scope: JobDetailScopeHost, signal: AbortSignal): Promise<void> {
  const runtime = runtimeFor(scope);
  const runId = ++runtime.generation;
  const requestedJobId = scope.jobId;
  const ownerToken = runtime.ownerToken;
  scope.loadError = null;
  try {
    const candidate = await fetchJobBundle(
      scope.api,
      requestedJobId,
      signal,
      scope.jobMemoryV2Enabled === true,
    );
    if (signal.aborted || scope.$disposed) return;
    if (runId !== runtime.generation || ownerToken !== runtime.ownerToken) return;
    if (requestedJobId !== scope.jobId) return;
    scope.acceptBundle(candidate);
  } catch (error) {
    if (signal.aborted || scope.$disposed || (error as Error).name === 'AbortError') return;
    if (runId !== runtime.generation || ownerToken !== runtime.ownerToken) return;
    if (requestedJobId !== scope.jobId) return;
    scope.loadError = error instanceof ApiError && error.status === 404
      ? { kind: 'not-found', message: '岗位不存在或已被删除。' }
      : { kind: 'error', message: (error as Error).message };
  }
}

export const jobDetailTasks = {
  loadJobBundle: {
    trigger: 'enter',
    canRun(this: JobDetailScopeHost): boolean {
      return this.runtimeEnabled === true
        && !this.$disposed
        && this.$status.active
        && typeof this.jobId === 'string'
        && this.jobId.trim() !== '';
    },
    reset(this: JobDetailScopeHost): void {
      // flag=false 代表 direct fallback；Runtime skip 不得清理正在读取的 direct 状态。
      if (this.runtimeEnabled !== true) return;
      clearTaskReadState(this);
    },
    async run(this: JobDetailScopeHost, { signal }: { signal: AbortSignal | null }): Promise<void> {
      if (signal === null) return;
      await executeBundleLoad(this, signal);
    },
  },
} satisfies RuntimeTaskMap<JobDetailScopeHost>;

export function createJobDraft(job: JobRecord): JobEditDraft {
  return {
    company: job.company,
    role: job.role,
    city: job.city,
    salaryRange: job.salaryRange,
    jdText: job.jdText,
    companyInput: { ...job.companyInput },
  };
}

export function fingerprintJobDraft(draft: JobEditDraft | null): string {
  if (draft === null) return '';
  return JSON.stringify({
    company: draft.company.trim(),
    role: draft.role.trim(),
    city: draft.city.trim(),
    salaryRange: draft.salaryRange.trim(),
    jdText: draft.jdText.trim(),
    companyInput: draft.companyInput,
  });
}

function sortedWithUpdatedJob(allJobs: JobRecord[], updatedJob: JobRecord): JobRecord[] {
  const withoutUpdated = allJobs.filter((job) => job.id !== updatedJob.id);
  return [updatedJob, ...withoutUpdated].sort((a, b) => b.updatedAt - a.updatedAt);
}

function emptyState(): JobDetailState {
  const applicationDrafts = {
    create: null,
    edit: null,
    void: null,
    baselineFingerprint: '',
  };
  applicationDrafts.baselineFingerprint = fingerprintApplicationDrafts(applicationDrafts);
  return {
    jobDraft: null,
    baselineFingerprint: '',
    analysisDraft: { rawText: '', dirty: false, streamRunId: 0, error: '' },
    loadError: null,
    actionStatus: {},
    selectedApplicationId: null,
    applicationDrafts,
    eventDraft: null,
    eventVoidDraft: null,
    eventDraftBaselineFingerprint: fingerprintEventDrafts(null, null),
    timelineUi: { composerExpanded: false, focusedEventId: null },
    decisionJobPreview: null,
  };
}

function resetApplicationDrafts(scope: JobDetailScopeHost): void {
  scope.applicationDrafts = {
    create: null,
    edit: null,
    void: null,
    baselineFingerprint: '',
  };
  scope.applicationDrafts.baselineFingerprint = fingerprintApplicationDrafts(scope.applicationDrafts);
}

function resetEventDrafts(scope: JobDetailScopeHost): void {
  scope.eventDraft = null;
  scope.eventVoidDraft = null;
  scope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
  scope.timelineUi = { composerExpanded: false, focusedEventId: null };
}

function memorySummaries(memory: JobMemoryBundle) {
  return memory.applications.map(({ record, projection }) => ({ record, projection }));
}

function defaultDecisionApplication(
  applications: readonly ApplicationSummary[],
): ApplicationSummary | null {
  const selected = selectDefaultApplication(applications.map(({ record, projection }) => ({
    application: record,
    projection,
  })));
  return selected === null
    ? null
    : applications.find(({ record }) => record.id === selected.application.id) ?? null;
}

function decisionFactsForJob(
  job: JobRecord,
  applications: readonly ApplicationSummary[],
  jobMemoryV2Enabled: boolean,
  selectedApplication: ApplicationSummary | ApplicationMemory | null = null,
): DecisionOpportunityFacts {
  return resolveDecisionOpportunityFacts({
    job,
    selectedApplication,
    defaultApplication: defaultDecisionApplication(applications),
    availableApplications: applications,
    jobMemoryV2Enabled,
  });
}

async function executeMemoryWrite(
  scope: JobDetailScopeHost,
  operation: (api: NonNullable<JobDetailScopeInjection['api']['jobMemory']>) => Promise<JobMemoryBundle>,
  draftOwner: 'application' | 'event',
): Promise<JobMemoryBundle> {
  const api = scope.api.jobMemory;
  if (api === undefined || scope.jobMemoryV2Enabled !== true) {
    throw new ApplicationApiError('HTTP_ERROR', 'Job Memory v2 功能未启用');
  }
  const runtime = runtimeFor(scope);
  const ownerToken = runtime.ownerToken;
  const requestedJobId = scope.jobId;
  scope.actionStatus.applicationWrite = 'loading';
  try {
    const memory = await operation(api);
    if (
      !scope.$disposed
      && ownerToken === runtime.ownerToken
      && requestedJobId === scope.jobId
    ) {
      scope.acceptMemoryBundle(memory);
      if (draftOwner === 'application') resetApplicationDrafts(scope);
      else resetEventDrafts(scope);
      scope.actionStatus.applicationWrite = 'done';
    }
    return memory;
  } catch (error) {
    if (!scope.$disposed && ownerToken === runtime.ownerToken && requestedJobId === scope.jobId) {
      scope.actionStatus.applicationWrite = 'error';
      if (
        error instanceof ApplicationApiError
        && (
          error.code === 'NETWORK_ERROR'
          || error.code === 'VERSION_CONFLICT'
          || error.code === 'EVENT_ALREADY_VOIDED'
        )
      ) {
        try {
          await scope.reloadJobBundle();
        } catch {
          // 保留原始稳定错误；草稿不清空，用户可再次读取或用同一幂等键重试。
        }
      }
    }
    throw error;
  }
}

export const useJobDetailScope = definePageScope<
  JobDetailState,
  JobDetailSource,
  JobDetailGetters,
  JobDetailActions,
  JobDetailScopeInjection
>('job-detail', {
  source: () => ({ bundle: null }),
  state: emptyState,
  getters: {
    isDirty(): boolean {
      return fingerprintJobDraft(this.jobDraft) !== this.baselineFingerprint
        || this.isApplicationDirty
        || this.isEventDirty;
    },
    isApplicationDirty(): boolean {
      return fingerprintApplicationDrafts(this.applicationDrafts)
        !== this.applicationDrafts.baselineFingerprint;
    },
    isEventDirty(): boolean {
      return fingerprintEventDrafts(this.eventDraft, this.eventVoidDraft)
        !== this.eventDraftBaselineFingerprint;
    },
    job(): JobRecord | null {
      return this.$source.bundle?.job ?? null;
    },
    selectedApplicationMemory(): ApplicationMemory | null {
      const bundle = this.$source.bundle;
      if (bundle === null || !isJobDetailBundleV2(bundle)) return null;
      return bundle.memory.applications.find(
        ({ record }) => record.id === this.selectedApplicationId,
      ) ?? null;
    },
    decisionFacts(): DecisionOpportunityFacts | null {
      const bundle = this.$source.bundle;
      if (bundle === null) return null;
      const job = this.decisionJobPreview ?? bundle.job;
      const applications = isJobDetailBundleV2(bundle)
        ? bundle.applicationSummariesByJob[bundle.jobId] ?? []
        : [];
      return decisionFactsForJob(
        job,
        applications,
        this.jobMemoryV2Enabled === true,
        this.selectedApplicationMemory,
      );
    },
    decisionFactsSource(): DecisionFactsSource | null {
      return this.decisionFacts?.source ?? null;
    },
    decisionResult(): DerivedDecision | null {
      const bundle = this.$source.bundle;
      const facts = this.decisionFacts;
      if (bundle === null || facts === null) return null;
      const v2 = this.jobMemoryV2Enabled === true && isJobDetailBundleV2(bundle);
      const companyOpportunities = bundle.allJobs.map((candidate) => decisionFactsForJob(
        candidate.id === facts.job.id ? facts.job : candidate,
        v2 ? bundle.applicationSummariesByJob[candidate.id] ?? [] : [],
        v2,
        candidate.id === facts.job.id ? this.selectedApplicationMemory : null,
      ));
      return deriveDecision(facts, {
        companyOpportunities,
        companyWarningMode: v2 ? 'trusted' : 'legacy',
      });
    },
    decisionCompatibilityWarning(): string | null {
      return this.jobMemoryV2Enabled === true
        && this.decisionFactsSource === 'legacy_job_fallback'
        ? '历史兼容状态，尚未迁移为事件事实。旧数据只读，建议建立 Application。'
        : null;
    },
  },
  actions: {
    acceptBundle(bundle: JobDetailBundle): void {
      const previousSelectedApplicationId = this.selectedApplicationId;
      const draft = createJobDraft(bundle.job);
      this.$source.bundle = {
        ...bundle,
        allJobs: [...bundle.allJobs],
      };
      this.jobDraft = draft;
      this.baselineFingerprint = fingerprintJobDraft(draft);
      this.selectedApplicationId = isJobDetailBundleV2(bundle)
        ? reconcileSelectedApplicationId(bundle.memory.applications, this.selectedApplicationId)
        : null;
      if (this.selectedApplicationId !== previousSelectedApplicationId) resetEventDrafts(this);
      this.loadError = null;
      this.decisionJobPreview = bundle.job;
    },
    acceptMemoryBundle(memory: JobMemoryBundle): void {
      const bundle = this.$source.bundle;
      if (bundle === null || !isJobDetailBundleV2(bundle) || bundle.jobId !== this.jobId) return;
      this.$source.bundle = {
        ...bundle,
        memory,
        applicationSummariesByJob: {
          ...bundle.applicationSummariesByJob,
          [bundle.jobId]: memorySummaries(memory),
        },
      };
      const previousSelectedApplicationId = this.selectedApplicationId;
      this.selectedApplicationId = reconcileSelectedApplicationId(
        memory.applications,
        this.selectedApplicationId,
      );
      if (this.selectedApplicationId !== previousSelectedApplicationId) resetEventDrafts(this);
    },
    acceptUpdatedJob(updatedJob: JobRecord, options: AcceptUpdatedJobOptions = {}): void {
      const bundle = this.$source.bundle;
      if (bundle === null || bundle.jobId !== updatedJob.id) return;
      const draft = createJobDraft(updatedJob);
      this.$source.bundle = {
        ...bundle,
        job: updatedJob,
        allJobs: sortedWithUpdatedJob(bundle.allJobs, updatedJob),
      };
      this.jobDraft = draft;
      this.baselineFingerprint = fingerprintJobDraft(draft);
      if (options.reason === 'confirmAnalysis') {
        this.analysisDraft = { rawText: '', dirty: false, streamRunId: 0, error: '' };
      }
      this.decisionJobPreview = updatedJob;
    },
    async loadDirect(): Promise<void> {
      const runtime = runtimeFor(this);
      runtime.controller?.abort();
      const controller = new AbortController();
      runtime.controller = controller;
      await executeBundleLoad(this, controller.signal);
      if (runtime.controller === controller) runtime.controller = null;
    },
    async reloadJobBundle(): Promise<void> {
      if (this.runtimeEnabled === true) {
        await this.$task.run('loadJobBundle');
        return;
      }
      await this.loadDirect();
    },
    async patchJob(patch: JobPatch, options: AcceptUpdatedJobOptions = {}): Promise<JobRecord> {
      const updated = await this.api.jobs.patch(this.jobId, patch);
      if (!this.$disposed) this.acceptUpdatedJob(updated, options);
      return updated;
    },
    async createApplication(input): Promise<JobMemoryBundle> {
      return executeMemoryWrite(this, (api) => api.createApplication(this.jobId, input), 'application');
    },
    async updateApplication(applicationId, input): Promise<JobMemoryBundle> {
      return executeMemoryWrite(this, (api) => api.updateApplication(applicationId, input), 'application');
    },
    async voidApplication(applicationId, input): Promise<JobMemoryBundle> {
      return executeMemoryWrite(this, (api) => api.voidApplication(applicationId, input), 'application');
    },
    async appendFeedbackEvent(applicationId, input): Promise<JobMemoryBundle> {
      return executeMemoryWrite(this, (api) => api.appendFeedbackEvent(applicationId, input), 'event');
    },
    async voidFeedbackEvent(eventId, input): Promise<JobMemoryBundle> {
      return executeMemoryWrite(this, (api) => api.voidFeedbackEvent(eventId, input), 'event');
    },
    resetEventDrafts(): void {
      resetEventDrafts(this);
    },
    async saveJobDraft(): Promise<JobRecord | null> {
      if (this.jobDraft === null) return null;
      return this.patchJob({ ...this.jobDraft, companyInput: { ...this.jobDraft.companyInput } });
    },
    async confirmAnalysis(patch: JobPatch): Promise<JobRecord> {
      return this.patchJob(patch, { reason: 'confirmAnalysis' });
    },
    async submitImportReview(patch: JobPatch): Promise<JobRecord> {
      return this.patchJob(patch);
    },
    async updateCommunication(patch: JobPatch): Promise<JobRecord> {
      if (this.jobMemoryV2Enabled === true) {
        const blocked = Object.keys(patch).filter((key) => (
          LEGACY_COMMUNICATION_PATCH_FIELDS.has(key as keyof JobRecord)
          || (key === 'draftMessageText' && this.decisionFactsSource === 'application_projection')
        ));
        if (blocked.length > 0) {
          throw new ApiError(
            'Job Memory v2 模式下旧沟通事实只读',
            422,
            { code: 'LEGACY_COMMUNICATION_WRITE_DISABLED', fields: blocked },
          );
        }
      }
      return this.patchJob(patch);
    },
    async saveMatchScore(matchScore: string): Promise<JobRecord> {
      return this.patchJob({ matchScore });
    },
    async saveGreeting(input: SaveGreetingInput): Promise<JobRecord> {
      return this.patchJob({ report: input.report });
    },
    appendOcrText(text: string): void {
      if (this.jobDraft === null || text.trim() === '') return;
      const separator = '--- OCR 识别结果 ---';
      this.jobDraft.jdText = this.jobDraft.jdText.trim() === ''
        ? `${separator}\n${text.trim()}`
        : `${this.jobDraft.jdText.trimEnd()}\n\n${separator}\n${text.trim()}`;
    },
    setDecisionJobPreview(job: JobRecord | null): void {
      this.decisionJobPreview = job;
    },
    async discardDraftAndReload(): Promise<void> {
      await this.reloadJobBundle();
    },
  },
  tasks: jobDetailTasks,
  enter() {
    if (this.runtimeEnabled !== true) void this.loadDirect();
  },
  leave() {
    const runtime = loadRuntime.get(this);
    if (runtime) {
      runtime.generation += 1;
      runtime.ownerToken = Symbol('destroyed-job-detail-owner');
      runtime.controller?.abort();
      runtime.controller = null;
    }
  },
});

export type JobDetailScope = ReturnType<typeof useJobDetailScope>;

export function injectJobDetailScope(): JobDetailScope | null {
  return injectPageScope<JobDetailScope>();
}

export type AnyJobDetailPageScope = PageScope<JobDetailState, JobDetailSource>;
