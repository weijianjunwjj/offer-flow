import { apiGet, apiSend, type ReadOptions, type SendOptions } from './client';

const base = '/radar';

/**
 * 采集桥要求所有请求携带该自定义头（强制触发 CORS 预检，见 server/radar/routes.ts）。
 * 必须由前端每次调用显式附加，否则会被 assertCaptureRequestAllowed 拒绝。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const captureHeaders = { [CAPTURE_CLIENT_HEADER]: 'offerflow-web' };

function withCaptureHeaders<T extends { headers?: Record<string, string> } | undefined>(
  options: T,
): T & { headers: Record<string, string> } {
  return { ...(options ?? {} as T), headers: { ...captureHeaders, ...options?.headers } };
}

export interface RadarCaptureRecognizedFields {
  company: string | null;
  role: string | null;
  city: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
}

export interface RadarCaptureSessionSummary {
  id: string;
  sourceType: string;
  status: 'preview' | 'committed' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt: number;
  committedAt: number | null;
}

export interface RadarPreviewItem {
  index: number;
  captureMethod: string;
  providerKey: string | null;
  providerVersion: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  normalizedSourceUrl: string | null;
  pageTitle: string | null;
  visibleText: string;
  externalRecordId: string | null;
  recognizedFields: RadarCaptureRecognizedFields | null;
  /** 服务端 raw_snapshot 旁注（已在 DTO 中定义）：含 commitBlocked / blockingIssues / 每字段 provenance。 */
  extractionMetadata?: Record<string, unknown> | null;
  correctionNote: string | null;
  capturedAt: number;
  rawContentHash: string;
}

export interface RadarCaptureSessionView {
  session: RadarCaptureSessionSummary;
  items: RadarPreviewItem[];
}

export interface RadarCommitOutcomeItem {
  index: number;
  candidateId: string;
  candidateVersionId: string;
  sourceRecordId: string;
  snapshotId: string;
  kind: 'created' | 'unchanged' | 'new_version';
}

export interface RadarCommitCaptureSessionResult {
  session: RadarCaptureSessionSummary;
  outcomes: RadarCommitOutcomeItem[];
}

export interface RadarCaptureItemCorrection {
  index: number;
  recognizedFields: RadarCaptureRecognizedFields;
  correctionNote?: string | null;
}

export const radarApi = {
  async getSession(id: string, options?: ReadOptions): Promise<RadarCaptureSessionView> {
    return apiGet<RadarCaptureSessionView>(`${base}/capture-sessions/${encodeURIComponent(id)}`, withCaptureHeaders(options));
  },
  async cancelSession(id: string, options?: SendOptions): Promise<RadarCaptureSessionSummary> {
    return apiSend(`${base}/capture-sessions/${encodeURIComponent(id)}/cancel`, 'POST', {}, withCaptureHeaders(options));
  },
  async commitSession(
    id: string,
    input: { confirmedIndexes: number[]; corrections?: RadarCaptureItemCorrection[] },
    options?: SendOptions,
  ): Promise<RadarCommitCaptureSessionResult> {
    return apiSend(`${base}/capture-sessions/${encodeURIComponent(id)}/commit`, 'POST', input, withCaptureHeaders(options));
  },
};
