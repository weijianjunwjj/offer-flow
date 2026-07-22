export const OFFERFLOW_BASE_URL = 'http://127.0.0.1:17365';
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const CAPTURE_CLIENT_VALUE = 'offerflow-capture-extension';

export interface CaptureRecognizedFields {
  company: string | null;
  role: string | null;
  city: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
}

export interface AddCaptureItemPayload {
  captureMethod: 'boss_current_page' | 'generic_visible_text';
  sourceUrl: string | null;
  pageTitle: string | null;
  visibleText: string;
  recognizedFields: CaptureRecognizedFields | null;
  /** 完整 rich extraction 旁注（district/详细地址/每字段 source/confidence/qualityIssues）。 */
  extractionMetadata?: Record<string, unknown> | null;
  /** 稳定岗位身份（§六）：服务端已有 providerKey/externalRecordId DTO 字段，用于精确去重。 */
  providerKey?: string | null;
  externalRecordId?: string | null;
}

export class OfferFlowNotRunningError extends Error {
  constructor() {
    super('OFFERFLOW_NOT_RUNNING');
    this.name = 'OfferFlowNotRunningError';
  }
}

async function postJson(pathname: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${OFFERFLOW_BASE_URL}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CAPTURE_CLIENT_HEADER]: CAPTURE_CLIENT_VALUE,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // 本机 OfferFlow 未启动或端口不可达：只提示明确错误，不做端口扫描或重试探测。
    throw new OfferFlowNotRunningError();
  }
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ code: 'UNKNOWN_ERROR', message: response.statusText }));
    throw new Error(`${errorBody.code ?? 'UNKNOWN_ERROR'}: ${errorBody.message ?? response.statusText}`);
  }
  return response.json();
}

export async function createCaptureSession(sourceType: 'browser' = 'browser'): Promise<{ session: { id: string } }> {
  return postJson('/radar/capture-sessions', { sourceType }) as Promise<{ session: { id: string } }>;
}

export async function addCaptureItem(sessionId: string, payload: AddCaptureItemPayload): Promise<unknown> {
  return postJson(`/radar/capture-sessions/${encodeURIComponent(sessionId)}/items`, payload);
}

export function buildPreviewUrl(sessionId: string): string {
  return `${OFFERFLOW_BASE_URL}/#/radar/import?sessionId=${encodeURIComponent(sessionId)}`;
}
