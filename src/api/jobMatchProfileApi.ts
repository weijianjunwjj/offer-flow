import { JobMatchProfileDraftSchema, JobMatchProfileStateSchema, type JobMatchProfileDraft, type JobMatchProfileState } from '../domain/job-match-profile';
import { apiGet, apiSend, type ReadOptions } from './client';

function parseState(value: unknown): JobMatchProfileState {
  return JobMatchProfileStateSchema.parse(value);
}

export const jobMatchProfileApi = {
  async get(options?: ReadOptions): Promise<JobMatchProfileState> {
    return parseState(await apiGet<unknown>('/job-match-profile', options));
  },
  async createManualProposal(
    expectedStateVersion: number,
    draft?: JobMatchProfileDraft,
  ): Promise<JobMatchProfileState> {
    return parseState(await apiSend<unknown>('/job-match-profile/proposals/manual', 'POST', {
      expectedStateVersion,
      ...(draft ? { draft: JobMatchProfileDraftSchema.parse(draft) } : {}),
    }));
  },
  async createAiProposal(expectedStateVersion: number): Promise<JobMatchProfileState> {
    return parseState(await apiSend<unknown>('/job-match-profile/proposals/ai', 'POST', {
      expectedStateVersion,
    }));
  },
  async decideProposal(
    proposalId: string,
    input: {
      expectedStateVersion: number;
      action: 'accept' | 'modify_and_accept' | 'reject' | 'defer';
      note?: string;
      deferredUntil?: number | null;
      modifiedDraft?: JobMatchProfileDraft;
    },
  ): Promise<JobMatchProfileState> {
    return parseState(await apiSend<unknown>(
      `/job-match-profile/proposals/${encodeURIComponent(proposalId)}/decision`,
      'POST',
      input,
    ));
  },
  async activateVersion(versionId: string, expectedStateVersion: number): Promise<JobMatchProfileState> {
    return parseState(await apiSend<unknown>(
      `/job-match-profile/versions/${encodeURIComponent(versionId)}/activate`,
      'POST',
      { expectedStateVersion },
    ));
  },
};
