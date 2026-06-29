import { BrowserStorageDriver } from './driver';
import { ConfigStore } from './configStore';
import { JobStore } from './jobStore';
import type { StorageDriver } from './driver';
import type { JobCreateInput, JobRecord, JobSeekerProfile } from './types';
import type { AsyncOfferFlowStores, JobRepository, ProfileRepository } from './ports';

export class LocalStorageProfileRepository implements ProfileRepository {
  constructor(private readonly store: ConfigStore) {}

  async getProfile(): Promise<JobSeekerProfile | null> {
    return this.store.getProfile();
  }

  async saveProfile(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return this.store.saveProfile(profile);
  }

  async clearProfile(): Promise<void> {
    this.store.clearProfile();
  }
}

export class LocalStorageJobRepository implements JobRepository {
  constructor(private readonly store: JobStore) {}

  async createJob(input: JobCreateInput = {}): Promise<JobRecord> {
    return this.store.createJob(input);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.store.getJob(id);
  }

  async listJobs(): Promise<JobRecord[]> {
    return this.store.listJobs();
  }

  async updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>,
  ): Promise<JobRecord> {
    return this.store.updateJob(id, patch);
  }

  async deleteJob(id: string): Promise<void> {
    this.store.deleteJob(id);
  }
}

export function createLocalStorageAsyncStores(
  driver: StorageDriver = new BrowserStorageDriver(),
): AsyncOfferFlowStores {
  return {
    backend: 'localStorage',
    config: new LocalStorageProfileRepository(new ConfigStore(driver)),
    jobs: new LocalStorageJobRepository(new JobStore(driver)),
  };
}
