import type {
  CompanyInput,
  JobRecord,
  JobReport,
  JobSeekerProfile,
} from '../storage';

export interface JobEditDraft {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
  companyInput: CompanyInput;
}

export interface JobDetailBundle {
  jobId: string;
  job: JobRecord;
  profile: JobSeekerProfile | null;
  allJobs: JobRecord[];
}

export interface AnalysisDraft {
  rawText: string;
  dirty: boolean;
  streamRunId: number;
  error: string;
}

export interface PageLoadError {
  kind: 'not-found' | 'error';
  message: string;
}

export type JobPatch = Partial<Omit<JobRecord, 'id' | 'createdAt'>>;

export interface JobDetailApiPorts {
  jobs: {
    get(id: string, options?: { signal?: AbortSignal }): Promise<JobRecord>;
    list(options?: { signal?: AbortSignal }): Promise<JobRecord[]>;
    patch(id: string, patch: JobPatch): Promise<JobRecord>;
  };
  profile: {
    get(options?: { signal?: AbortSignal }): Promise<JobSeekerProfile | null>;
  };
}

export interface JobDetailScopeInjection {
  jobId: string;
  api: JobDetailApiPorts;
}

export interface AcceptUpdatedJobOptions {
  reason?: 'confirmAnalysis' | 'write';
}

export interface JobDetailState {
  jobDraft: JobEditDraft | null;
  baselineFingerprint: string;
  analysisDraft: AnalysisDraft;
  loadError: PageLoadError | null;
  actionStatus: Record<string, 'idle' | 'loading' | 'done' | 'error'>;
}

export interface JobDetailSource {
  bundle: JobDetailBundle | null;
}

export interface SaveGreetingInput {
  report: JobReport;
}
