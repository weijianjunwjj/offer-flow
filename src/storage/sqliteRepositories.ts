import { emptyCompanyInput, withJobRecordDefaults } from './defaults';
import { newId } from './id';
import { TauriSQLiteClient } from './sqliteClient';
import type { StoredJobRecord } from './defaults';
import type { SQLiteClient } from './sqliteClient';
import type { AsyncOfferFlowStores, JobRepository, ProfileRepository } from './ports';
import type { JobCreateInput, JobRecord, JobSeekerProfile } from './types';

export class SQLiteProfileRepository implements ProfileRepository {
  constructor(private readonly client: SQLiteClient = new TauriSQLiteClient()) {}

  getProfile(): Promise<JobSeekerProfile | null> {
    return this.client.getProfile();
  }

  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return this.client.saveProfile(profile);
  }

  async clearProfile(): Promise<void> {
    await this.client.clearProfile();
  }
}

export class SQLiteJobRepository implements JobRepository {
  constructor(private readonly client: SQLiteClient = new TauriSQLiteClient()) {}

  async createJob(input: JobCreateInput = {}): Promise<JobRecord> {
    const now = Date.now();
    const job: JobRecord = {
      id: newId(),
      createdAt: now,
      updatedAt: now,

      company: input.company ?? '',
      role: input.role ?? '',
      city: input.city ?? '',
      salaryRange: input.salaryRange ?? '',
      jdText: input.jdText ?? '',

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
      highValueSignal: false,
    };
    return withJobRecordDefaults(await this.client.createJob(job) as StoredJobRecord);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = await this.client.getJob(id);
    return job === null ? null : withJobRecordDefaults(job as StoredJobRecord);
  }

  async listJobs(): Promise<JobRecord[]> {
    const jobs = await this.client.listJobs();
    return jobs
      .map((job) => withJobRecordDefaults(job as StoredJobRecord))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>,
  ): Promise<JobRecord> {
    const current = await this.getJob(id);
    if (current === null) {
      throw new Error(`[OfferFlow] Cannot update — job "${id}" does not exist.`);
    }
    const next: JobRecord = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    return withJobRecordDefaults(await this.client.updateJob(next) as StoredJobRecord);
  }

  async deleteJob(id: string): Promise<void> {
    await this.client.deleteJob(id);
  }
}

export function createSQLiteAsyncStores(
  client: SQLiteClient = new TauriSQLiteClient(),
): AsyncOfferFlowStores {
  return {
    backend: 'sqlite',
    config: new SQLiteProfileRepository(client),
    jobs: new SQLiteJobRepository(client),
  };
}
