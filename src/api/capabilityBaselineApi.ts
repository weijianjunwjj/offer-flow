import type {
  CandidateEvidenceContent,
  CapabilityBaselineDraft,
  CapabilityBaselineView,
} from '../domain/capability-baseline';
import { CapabilityBaselineViewSchema } from '../domain/capability-baseline';
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

export interface CapabilityCommandRequest {
  idempotencyKey: string;
  expectedStateVersion: number;
}

function checked(value: CapabilityBaselineView): CapabilityBaselineView {
  return CapabilityBaselineViewSchema.parse(value);
}

const base = '/capability-baseline';

export const capabilityBaselineApi = {
  async get(options?: ReadOptions): Promise<CapabilityBaselineView> {
    return checked(await apiGet<CapabilityBaselineView>(base, options));
  },

  async createManualEvidence(
    input: CapabilityCommandRequest & { content: CandidateEvidenceContent },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/evidence/manual`, 'POST', input, options));
  },
  async generateEvidence(
    input: CapabilityCommandRequest,
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/evidence/generate`, 'POST', input, options));
  },
  async acceptEvidence(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null; modifiedContent?: CandidateEvidenceContent },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/evidence/${encodeURIComponent(id)}/accept`, 'POST', input, options));
  },
  async rejectEvidence(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/evidence/${encodeURIComponent(id)}/reject`, 'POST', input, options));
  },
  async deferEvidence(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/evidence/${encodeURIComponent(id)}/defer`, 'POST', input, options));
  },

  async createManualBaselineProposal(
    input: CapabilityCommandRequest & { payload: CapabilityBaselineDraft },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/proposals/manual`, 'POST', input, options));
  },
  async generateBaselineProposal(
    input: CapabilityCommandRequest,
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/proposals/generate`, 'POST', input, options));
  },
  async acceptBaselineProposal(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null; modifiedPayload?: CapabilityBaselineDraft },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/accept`, 'POST', input, options));
  },
  async rejectBaselineProposal(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/reject`, 'POST', input, options));
  },
  async deferBaselineProposal(
    id: string,
    input: CapabilityCommandRequest & { decisionNote?: string | null },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/proposals/${encodeURIComponent(id)}/defer`, 'POST', input, options));
  },

  async activateVersion(
    id: string,
    input: CapabilityCommandRequest & { confirmed: true },
    options?: SendOptions,
  ): Promise<CapabilityBaselineView> {
    return checked(await apiSend(`${base}/versions/${encodeURIComponent(id)}/activate`, 'POST', input, options));
  },
};
