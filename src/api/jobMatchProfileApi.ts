import type {
  JobMatchProfileDraft,
  JobMatchProfileView,
} from '../domain/job-match-profile';
import { JobMatchProfileViewSchema } from '../domain/job-match-profile';
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

export interface JobMatchCommandRequest {
  idempotencyKey: string;
  expectedProfileStateVersion: number;
}

function checked(value: JobMatchProfileView): JobMatchProfileView {
  return JobMatchProfileViewSchema.parse(value);
}

export const jobMatchProfileApi = {
  async get(options?: ReadOptions): Promise<JobMatchProfileView> {
    return checked(await apiGet<JobMatchProfileView>('/job-match-profile', options));
  },
  async generate(input: JobMatchCommandRequest, options?: SendOptions): Promise<JobMatchProfileView> {
    return checked(await apiSend('/job-match-profile/proposals/generate', 'POST', input, options));
  },
  async manual(
    input: JobMatchCommandRequest & { payload: JobMatchProfileDraft },
    options?: SendOptions,
  ): Promise<JobMatchProfileView> {
    return checked(await apiSend('/job-match-profile/proposals/manual', 'POST', input, options));
  },
  async accept(
    id: string,
    input: JobMatchCommandRequest & { decisionNote?: string | null; modifiedPayload?: JobMatchProfileDraft },
    options?: SendOptions,
  ): Promise<JobMatchProfileView> {
    return checked(await apiSend(`/job-match-profile/proposals/${encodeURIComponent(id)}/accept`, 'POST', input, options));
  },
  async reject(
    id: string,
    input: JobMatchCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<JobMatchProfileView> {
    return checked(await apiSend(`/job-match-profile/proposals/${encodeURIComponent(id)}/reject`, 'POST', input, options));
  },
  async defer(
    id: string,
    input: JobMatchCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<JobMatchProfileView> {
    return checked(await apiSend(`/job-match-profile/proposals/${encodeURIComponent(id)}/defer`, 'POST', input, options));
  },
  async activate(
    id: string,
    input: JobMatchCommandRequest & { confirmed: true },
    options?: SendOptions,
  ): Promise<JobMatchProfileView> {
    return checked(await apiSend(`/job-match-profile/versions/${encodeURIComponent(id)}/activate`, 'POST', input, options));
  },
};
