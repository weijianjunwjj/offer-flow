import { injectPageScope, definePageScope, type PageScope } from 'vue-page-scope';
import { ApiError } from '../api/client';
import type { JobRecord } from '../storage';
import type {
  AcceptUpdatedJobOptions,
  JobDetailBundle,
  JobDetailScopeInjection,
  JobDetailSource,
  JobDetailState,
  JobEditDraft,
  JobPatch,
  SaveGreetingInput,
} from './jobDetailTypes';

interface LoadRuntime {
  generation: number;
  controller: AbortController | null;
  ownerToken: symbol;
}

interface JobDetailGetters {
  isDirty(): boolean;
  job(): JobRecord | null;
}

interface JobDetailActions {
  acceptBundle(bundle: JobDetailBundle): void;
  acceptUpdatedJob(updatedJob: JobRecord, options?: AcceptUpdatedJobOptions): void;
  loadDirect(): Promise<void>;
  patchJob(patch: JobPatch, options?: AcceptUpdatedJobOptions): Promise<JobRecord>;
  saveJobDraft(): Promise<JobRecord | null>;
  confirmAnalysis(patch: JobPatch): Promise<JobRecord>;
  submitImportReview(patch: JobPatch): Promise<JobRecord>;
  updateCommunication(patch: JobPatch): Promise<JobRecord>;
  saveMatchScore(matchScore: string): Promise<JobRecord>;
  saveGreeting(input: SaveGreetingInput): Promise<JobRecord>;
  appendOcrText(text: string): void;
  discardDraftAndReload(): Promise<void>;
}

const loadRuntime = new WeakMap<object, LoadRuntime>();

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
  return {
    jobDraft: null,
    baselineFingerprint: '',
    analysisDraft: { rawText: '', dirty: false, streamRunId: 0, error: '' },
    loadError: null,
    actionStatus: {},
  };
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
      return fingerprintJobDraft(this.jobDraft) !== this.baselineFingerprint;
    },
    job(): JobRecord | null {
      return this.$source.bundle?.job ?? null;
    },
  },
  actions: {
    acceptBundle(bundle: JobDetailBundle): void {
      const draft = createJobDraft(bundle.job);
      this.$source.bundle = {
        ...bundle,
        allJobs: [...bundle.allJobs],
      };
      this.jobDraft = draft;
      this.baselineFingerprint = fingerprintJobDraft(draft);
      this.loadError = null;
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
    },
    async loadDirect(): Promise<void> {
      const runtime = loadRuntime.get(this) ?? {
        generation: 0,
        controller: null,
        ownerToken: Symbol('job-detail-owner'),
      };
      loadRuntime.set(this, runtime);
      runtime.controller?.abort();
      runtime.controller = new AbortController();
      const runId = ++runtime.generation;
      const requestedJobId = this.jobId;
      const ownerToken = runtime.ownerToken;
      this.loadError = null;
      try {
        const [job, profile, allJobs] = await Promise.all([
          this.api.jobs.get(requestedJobId, { signal: runtime.controller.signal }),
          this.api.profile.get({ signal: runtime.controller.signal }),
          this.api.jobs.list({ signal: runtime.controller.signal }),
        ]);
        if (runtime.controller.signal.aborted || this.$disposed) return;
        if (runId !== runtime.generation || ownerToken !== runtime.ownerToken) return;
        if (requestedJobId !== this.jobId) return;
        this.acceptBundle({ jobId: requestedJobId, job, profile, allJobs });
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        this.loadError = error instanceof ApiError && error.status === 404
          ? { kind: 'not-found', message: '岗位不存在或已被删除。' }
          : { kind: 'error', message: (error as Error).message };
      }
    },
    async patchJob(patch: JobPatch, options: AcceptUpdatedJobOptions = {}): Promise<JobRecord> {
      const updated = await this.api.jobs.patch(this.jobId, patch);
      if (!this.$disposed) this.acceptUpdatedJob(updated, options);
      return updated;
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
    async discardDraftAndReload(): Promise<void> {
      await this.loadDirect();
    },
  },
  enter() {
    void this.loadDirect();
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
