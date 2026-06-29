import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { JobRecord, JobSeekerProfile } from './types';

export interface SQLiteClient {
  getProfile(): Promise<JobSeekerProfile | null>;
  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile>;
  clearProfile(): Promise<void>;
  createJob(job: JobRecord): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  listJobs(): Promise<JobRecord[]>;
  updateJob(job: JobRecord): Promise<JobRecord>;
  deleteJob(id: string): Promise<void>;
}

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriSQLiteClient implements SQLiteClient {
  constructor(private readonly invoke: TauriInvoke = tauriInvoke) {}

  getProfile(): Promise<JobSeekerProfile | null> {
    return this.invoke('sqlite_get_profile');
  }

  saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return this.invoke('sqlite_save_profile', {
      profileJson: JSON.stringify(profile),
    });
  }

  async clearProfile(): Promise<void> {
    await this.invoke<boolean>('sqlite_clear_profile');
  }

  createJob(job: JobRecord): Promise<JobRecord> {
    return this.invoke('sqlite_create_job', {
      jobJson: JSON.stringify(job),
    });
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.invoke('sqlite_get_job', { id });
  }

  listJobs(): Promise<JobRecord[]> {
    return this.invoke('sqlite_list_jobs');
  }

  updateJob(job: JobRecord): Promise<JobRecord> {
    return this.invoke('sqlite_update_job', {
      jobJson: JSON.stringify(job),
    });
  }

  async deleteJob(id: string): Promise<void> {
    await this.invoke<boolean>('sqlite_delete_job', { id });
  }
}
