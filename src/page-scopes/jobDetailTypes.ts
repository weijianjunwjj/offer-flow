import type {
  CompanyInput,
  JobRecord,
  JobReport,
  JobSeekerProfile,
} from '../storage';
import type {
  JobDetailBundleV2,
  JobMemoryBundle,
} from '../domain/job-memory';
import type { ApplicationApiPort } from '../api/jobMemoryApi';
import type {
  CreateApplicationRequest,
  UpdateApplicationMetadataRequest,
  VoidApplicationRequest,
} from '../../server/job-memory/dtoSchemas';
import type { ApplicationDraftState } from '../pages/job-detail/applicationSectionModel';

export interface JobEditDraft {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
  companyInput: CompanyInput;
}

export interface JobDetailBundleV1 {
  jobId: string;
  job: JobRecord;
  profile: JobSeekerProfile | null;
  allJobs: JobRecord[];
}

export type JobDetailBundle = JobDetailBundleV1 | JobDetailBundleV2;

export function isJobDetailBundleV2(bundle: JobDetailBundle): bundle is JobDetailBundleV2 {
  return 'memory' in bundle;
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
  jobMemory?: ApplicationApiPort;
}

export interface JobDetailScopeInjection {
  jobId: string;
  api: JobDetailApiPorts;
  runtimeEnabled?: boolean;
  jobMemoryV2Enabled?: boolean;
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
  selectedApplicationId: string | null;
  applicationDrafts: ApplicationDraftState;
}

export interface JobDetailSource {
  bundle: JobDetailBundle | null;
}

export interface SaveGreetingInput {
  report: JobReport;
}

export interface ApplicationWriteActions {
  acceptMemoryBundle(memory: JobMemoryBundle): void;
  createApplication(input: CreateApplicationRequest): Promise<JobMemoryBundle>;
  updateApplication(
    applicationId: string,
    input: UpdateApplicationMetadataRequest,
  ): Promise<JobMemoryBundle>;
  voidApplication(applicationId: string, input: VoidApplicationRequest): Promise<JobMemoryBundle>;
}
