import {
  projectApplication,
  selectDefaultApplication,
  type ApplicationRecord,
  type ResumeVersionRecord,
} from '../../src/domain/job-memory';
import type { JobRecord } from '../../src/storage';
import type { SqliteDatabase } from '../db';
import { JobRepository } from '../repositories/jobRepository';
import { ProfileRepository } from '../repositories/profileRepository';
import { ApplicationRepository } from './applicationRepository';
import { notFound, StorageCorruptionError } from './errors';
import { FeedbackEventRepository } from './feedbackEventRepository';
import { ResumeVersionRepository } from './resumeVersionRepository';
import type {
  ApplicationMemory,
  ApplicationSummary,
  JobDetailBundleV2,
  JobMemoryBundle,
  JobSummary,
} from './types';

export class JobMemoryQueries {
  private readonly resumeVersions: ResumeVersionRepository;
  private readonly applications: ApplicationRepository;
  private readonly events: FeedbackEventRepository;
  private readonly jobs: JobRepository;
  private readonly profiles: ProfileRepository;

  constructor(db: SqliteDatabase) {
    this.resumeVersions = new ResumeVersionRepository(db);
    this.applications = new ApplicationRepository(db);
    this.events = new FeedbackEventRepository(db);
    this.jobs = new JobRepository(db);
    this.profiles = new ProfileRepository(db);
  }

  listResumeVersions(): { resumeVersions: ResumeVersionRecord[]; activeResumeVersionId: string | null } {
    const resumeVersions = this.resumeVersions.listResumeVersions();
    return {
      resumeVersions,
      activeResumeVersionId: this.checkedActiveResumeVersionId(resumeVersions),
    };
  }

  getActiveResumeVersionId(): string | null {
    return this.checkedActiveResumeVersionId(this.resumeVersions.listResumeVersions());
  }

  listApplicationsByJob(jobId: string): ApplicationMemory[] {
    return this.applications.listApplicationsByJob(jobId).map((record) => this.toMemory(record));
  }

  toMemory(record: ApplicationRecord): ApplicationMemory {
    const events = this.events.listEventsByApplication(record.id);
    return { record, events, projection: projectApplication(record, events) };
  }

  getJobMemoryBundle(jobId: string): JobMemoryBundle {
    this.requireJob(jobId);
    const resumeVersions = this.resumeVersions.listResumeVersions();
    return {
      applications: this.listApplicationsByJob(jobId),
      resumeVersions,
      activeResumeVersionId: this.checkedActiveResumeVersionId(resumeVersions),
    };
  }

  getJobSummaries(): JobSummary[] {
    const jobs = this.jobs.list();
    const summaries = this.applicationSummariesByJob(jobs);
    return jobs.map((job) => {
      const applications = summaries[job.id] ?? [];
      const selected = selectDefaultApplication(applications.map((summary) => ({
        application: summary.record,
        projection: summary.projection,
      })));
      return {
        job,
        applicationCount: applications.length,
        defaultApplication: selected === null
          ? null
          : applications.find((summary) => summary.record.id === selected.application.id) ?? null,
        projectionDiagnostics: applications
          .filter((summary) => summary.projection.projectionStatus !== 'valid')
          .map((summary) => ({
            applicationId: summary.record.id,
            projectionStatus: summary.projection.projectionStatus,
            warnings: summary.projection.warnings,
            errors: summary.projection.errors,
          })),
      };
    });
  }

  getJobDetailBundle(jobId: string): JobDetailBundleV2 {
    const job = this.requireJob(jobId);
    const allJobs = this.jobs.list();
    return {
      jobId,
      job,
      profile: this.profiles.get(),
      allJobs,
      applicationSummariesByJob: this.applicationSummariesByJob(allJobs),
      memory: this.getJobMemoryBundle(jobId),
    };
  }

  private applicationSummariesByJob(jobs: readonly JobRecord[]): Record<string, ApplicationSummary[]> {
    const summaries = Object.fromEntries(jobs.map((job) => [job.id, [] as ApplicationSummary[]]));
    for (const application of this.applications.listApplications()) {
      (summaries[application.jobId] ??= []).push({
        record: application,
        projection: projectApplication(
          application,
          this.events.listEventsByApplication(application.id),
        ),
      });
    }
    return summaries;
  }

  private checkedActiveResumeVersionId(resumeVersions: readonly ResumeVersionRecord[]): string | null {
    const activeId = this.resumeVersions.getActiveResumeVersionId();
    if (activeId !== null && !resumeVersions.some((resumeVersion) => resumeVersion.id === activeId)) {
      throw new StorageCorruptionError('active_resume_version_id 指向不存在的简历版本');
    }
    return activeId;
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (job === null) throw notFound('JOB_NOT_FOUND', '岗位不存在');
    return job;
  }
}
