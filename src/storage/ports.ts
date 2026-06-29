import type { JobCreateInput, JobRecord, JobSeekerProfile } from './types';

export type StorageBackend = 'localStorage' | 'sqlite';

export interface ProfileRepository {
  getProfile(): Promise<JobSeekerProfile | null>;
  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile>;
  clearProfile(): Promise<void>;
}

export interface JobRepository {
  createJob(input?: JobCreateInput): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(): Promise<JobRecord[]>;
  updateJob(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): Promise<JobRecord>;
  deleteJob(id: string): Promise<void>;
}

export interface AsyncOfferFlowStores {
  backend: StorageBackend;
  config: ProfileRepository;
  jobs: JobRepository;
}
