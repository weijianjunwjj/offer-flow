import type {
  ApplicationProjection,
  ApplicationRecord,
  FeedbackEventRecord,
  ResumeVersionRecord,
} from '../../src/domain/job-memory';
import type { JobRecord, JobSeekerProfile } from '../../src/storage';

export interface ApplicationMemory {
  record: ApplicationRecord;
  events: FeedbackEventRecord[];
  projection: ApplicationProjection;
}

export interface JobMemoryBundle {
  applications: ApplicationMemory[];
  resumeVersions: ResumeVersionRecord[];
  activeResumeVersionId: string | null;
}

export interface ApplicationSummary {
  record: ApplicationRecord;
  projection: ApplicationProjection;
}

export interface JobSummary {
  job: JobRecord;
  applicationCount: number;
  defaultApplication: ApplicationSummary | null;
  projectionDiagnostics: Array<{
    applicationId: string;
    projectionStatus: ApplicationProjection['projectionStatus'];
    warnings: ApplicationProjection['warnings'];
    errors: ApplicationProjection['errors'];
  }>;
}

export interface JobDetailBundleV2 {
  jobId: string;
  job: JobRecord;
  profile: JobSeekerProfile | null;
  allJobs: JobRecord[];
  applicationSummariesByJob: Record<string, ApplicationSummary[]>;
  memory: JobMemoryBundle;
}

export interface ActiveResumeResult {
  resumeVersion: ResumeVersionRecord;
  activeResumeVersionId: string | null;
}
