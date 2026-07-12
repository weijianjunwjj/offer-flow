import type { JobSeekerProfile } from '../storage';
import { apiGet, apiSend, type ReadOptions } from './client';

export const profileApi = {
  get(options?: ReadOptions): Promise<JobSeekerProfile | null> {
    return apiGet<JobSeekerProfile | null>('/profile', options);
  },
  save(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return apiSend<JobSeekerProfile>('/profile', 'PUT', profile);
  },
  delete(): Promise<{ ok: true }> {
    return apiSend<{ ok: true }>('/profile', 'DELETE');
  },
};
