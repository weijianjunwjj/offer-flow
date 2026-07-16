import type {
  EvidenceRawCounts,
  MarketPositionCityCode,
  MarketPositionDraft,
  MarketPositionView,
} from '../domain/market-position';
import { MarketPositionViewSchema } from '../domain/market-position';
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

export interface MarketPositionCommandRequest {
  idempotencyKey: string;
  expectedStateVersion: number;
}

export interface MarketPositionInputSnapshotResponse {
  jobMatchProfileVersionId: string | null;
  capabilityBaselineVersionId: string | null;
  acceptedEvidenceIds: string[];
  funnelCutoffAt: number;
  countsByScope: {
    global: EvidenceRawCounts;
    cities: Record<MarketPositionCityCode, EvidenceRawCounts>;
  };
  funnelQueryFingerprint: string;
  inputHash: string;
  capturedAt: number;
}

function checked(value: MarketPositionView): MarketPositionView {
  return MarketPositionViewSchema.parse(value);
}

const base = '/market-position';

export const marketPositionApi = {
  async get(options?: ReadOptions): Promise<MarketPositionView> {
    return checked(await apiGet<MarketPositionView>(base, options));
  },
  async getInputSnapshot(options?: ReadOptions): Promise<MarketPositionInputSnapshotResponse> {
    return apiGet<MarketPositionInputSnapshotResponse>(`${base}/input-snapshot`, options);
  },
  async createManualProposal(
    input: MarketPositionCommandRequest & { payload: MarketPositionDraft },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/proposals/manual`, 'POST', input, options));
  },
  async generateProposal(
    input: MarketPositionCommandRequest & { expectedInputHash?: string | null },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/proposals/generate`, 'POST', input, options));
  },
  async acceptProposal(
    id: string,
    input: MarketPositionCommandRequest & { decisionNote?: string | null; modifiedPayload?: MarketPositionDraft },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/accept`, 'POST', input, options));
  },
  async rejectProposal(
    id: string,
    input: MarketPositionCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/reject`, 'POST', input, options));
  },
  async deferProposal(
    id: string,
    input: MarketPositionCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/defer`, 'POST', input, options));
  },
  async activateVersion(
    id: string,
    input: MarketPositionCommandRequest & { confirmed: true },
    options?: SendOptions,
  ): Promise<MarketPositionView> {
    return checked(await apiSend(`${base}/versions/${encodeURIComponent(id)}/activate`, 'POST', input, options));
  },
};
