import type {
  HistoricalBaselineDraft,
  HistoricalBaselineDraftContent,
  HistoricalEventDraft,
  HistoricalEventDraftContent,
  HistoricalImportConfirmResult,
  HistoricalImportSession,
  HistoricalImportSessionBundle,
} from '../domain/history-import';
import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

const base = '/history-import';

export const historyImportApi = {
  async listSessions(options?: ReadOptions): Promise<HistoricalImportSession[]> {
    return apiGet<HistoricalImportSession[]>(`${base}/sessions`, options);
  },
  async createSession(options?: SendOptions): Promise<HistoricalImportSession> {
    return apiSend<HistoricalImportSession>(`${base}/sessions`, 'POST', undefined, options);
  },
  async getSessionBundle(id: string, options?: ReadOptions): Promise<HistoricalImportSessionBundle> {
    return apiGet<HistoricalImportSessionBundle>(`${base}/sessions/${encodeURIComponent(id)}`, options);
  },
  async markPreviewGenerated(
    id: string,
    input: { expectedVersion: number },
    options?: SendOptions,
  ): Promise<HistoricalImportSession> {
    return apiSend(`${base}/sessions/${encodeURIComponent(id)}/preview`, 'POST', input, options);
  },
  async confirmSession(
    id: string,
    input: { idempotencyKey: string; expectedVersion: number },
    options?: SendOptions,
  ): Promise<HistoricalImportConfirmResult> {
    return apiSend(`${base}/sessions/${encodeURIComponent(id)}/confirm`, 'POST', input, options);
  },
  async discardSession(
    id: string,
    input: { expectedVersion: number },
    options?: SendOptions,
  ): Promise<HistoricalImportSession> {
    return apiSend(`${base}/sessions/${encodeURIComponent(id)}/discard`, 'POST', input, options);
  },

  async createBaselineDraft(
    sessionId: string,
    input: HistoricalBaselineDraftContent,
    options?: SendOptions,
  ): Promise<HistoricalBaselineDraft> {
    return apiSend(`${base}/sessions/${encodeURIComponent(sessionId)}/baseline-drafts`, 'POST', input, options);
  },
  async updateBaselineDraft(
    id: string,
    input: HistoricalBaselineDraftContent & { expectedVersion: number },
    options?: SendOptions,
  ): Promise<HistoricalBaselineDraft> {
    return apiSend(`${base}/baseline-drafts/${encodeURIComponent(id)}`, 'PATCH', input, options);
  },
  async deleteBaselineDraft(id: string, options?: SendOptions): Promise<void> {
    await apiSend(`${base}/baseline-drafts/${encodeURIComponent(id)}`, 'DELETE', undefined, options);
  },

  async createEventDraft(
    baselineDraftId: string,
    input: HistoricalEventDraftContent,
    options?: SendOptions,
  ): Promise<HistoricalEventDraft> {
    return apiSend(`${base}/baseline-drafts/${encodeURIComponent(baselineDraftId)}/event-drafts`, 'POST', input, options);
  },
  async updateEventDraft(
    id: string,
    input: HistoricalEventDraftContent & { expectedVersion: number },
    options?: SendOptions,
  ): Promise<HistoricalEventDraft> {
    return apiSend(`${base}/event-drafts/${encodeURIComponent(id)}`, 'PATCH', input, options);
  },
  async deleteEventDraft(id: string, options?: SendOptions): Promise<void> {
    await apiSend(`${base}/event-drafts/${encodeURIComponent(id)}`, 'DELETE', undefined, options);
  },
};
