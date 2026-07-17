import type {
  StrategyInputSnapshot,
  StrategyProposalDraft,
  StrategyView,
} from '../domain/strategy-window';
import { StrategyViewSchema } from '../domain/strategy-window';
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

export interface StrategyCommandRequest {
  idempotencyKey: string;
  expectedStateVersion: number;
}

function checked(value: StrategyView): StrategyView {
  return StrategyViewSchema.parse(value) as StrategyView;
}

const base = '/strategy';

export const strategyWindowApi = {
  async get(options?: ReadOptions): Promise<StrategyView> {
    return checked(await apiGet<StrategyView>(`${base}/current`, options));
  },
  async getInputSnapshot(options?: ReadOptions): Promise<StrategyInputSnapshot | null> {
    return apiGet<StrategyInputSnapshot | null>(`${base}/input-snapshot`, options);
  },
  async createManualProposal(
    input: StrategyCommandRequest & { payload: StrategyProposalDraft },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/proposals/manual`, 'POST', input, options));
  },
  async generateProposal(
    input: StrategyCommandRequest & { expectedInputHash?: string | null },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/proposals/generate`, 'POST', input, options));
  },
  async acceptProposal(
    id: string,
    input: StrategyCommandRequest & { decisionNote?: string | null; modifiedPayload?: StrategyProposalDraft },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/accept`, 'POST', input, options));
  },
  async rejectProposal(
    id: string,
    input: StrategyCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/reject`, 'POST', input, options));
  },
  async deferProposal(
    id: string,
    input: StrategyCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/defer`, 'POST', input, options));
  },
  async activateVersion(
    id: string,
    input: StrategyCommandRequest & { confirmed: true },
    options?: SendOptions,
  ): Promise<StrategyView> {
    return checked(await apiSend(`${base}/versions/${encodeURIComponent(id)}/activate`, 'POST', input, options));
  },
};
