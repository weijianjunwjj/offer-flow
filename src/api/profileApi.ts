import type { JobSeekerProfile } from '../storage';
import { apiGet, apiSend } from './client';

export const profileApi = {
  get(): Promise<JobSeekerProfile | null> {
    return apiGet<JobSeekerProfile | null>('/profile');
  },
  save(profile: JobSeekerProfile): Promise<JobSeekerProfile> {
    return apiSend<JobSeekerProfile>('/profile', 'PUT', profile);
  },
  delete(): Promise<{ ok: true }> {
    return apiSend<{ ok: true }>('/profile', 'DELETE');
  },
};
