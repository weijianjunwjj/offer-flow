import type { JobCreateInput, JobRecord } from '../storage';
import { apiGet, apiSend } from './client';

export const jobsApi = {
  list(): Promise<JobRecord[]> {
    return apiGet<JobRecord[]>('/jobs');
  },
  create(input: JobCreateInput & Partial<JobRecord>): Promise<JobRecord> {
    return apiSend<JobRecord>('/jobs', 'POST', input);
  },
  get(id: string): Promise<JobRecord> {
    return apiGet<JobRecord>(`/jobs/${encodeURIComponent(id)}`);
  },
  replace(id: string, job: Partial<JobRecord>): Promise<JobRecord> {
    return apiSend<JobRecord>(`/jobs/${encodeURIComponent(id)}`, 'PUT', job);
  },
  patch(id: string, patch: Partial<Omit<JobRecord, 'id' | 'createdAt'>>): Promise<JobRecord> {
    return apiSend<JobRecord>(`/jobs/${encodeURIComponent(id)}`, 'PATCH', patch);
  },
  delete(id: string): Promise<{ ok: true }> {
    return apiSend<{ ok: true }>(`/jobs/${encodeURIComponent(id)}`, 'DELETE');
  },
};
