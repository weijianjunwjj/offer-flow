import type { PageCapturePayload, PageCaptureExecutionResult } from './captureResult';

/**
 * popup 采集流程的可注入依赖，把 chrome/DOM 副作用隔离出去以便单测：
 * - getCaptureResult：注入并读取页面采集结果（已归一化为判别联合）；
 * - createSession/addItem/openPreview：本机 OfferFlow 采集 API 与预览页跳转；
 * - setStatus：更新 popup 文案；
 * - onOfflineError：判断是否为「OfferFlow 未启动」错误。
 */
export interface CaptureFlowDeps {
  getCaptureResult: () => Promise<PageCaptureExecutionResult>;
  fallbackSourceUrl: () => string | null;
  createSession: () => Promise<{ id: string }>;
  addItem: (sessionId: string, payload: AddItemPayload) => Promise<void>;
  openPreview: (sessionId: string) => Promise<void>;
  setStatus: (message: string) => void;
  isOfflineError: (error: unknown) => boolean;
}

export interface AddItemPayload {
  captureMethod: PageCapturePayload['captureMethod'];
  sourceUrl: string | null;
  pageTitle: string | null;
  visibleText: string;
  recognizedFields: PageCapturePayload['recognizedFields'];
  extractionMetadata: PageCapturePayload['extractionMetadata'];
  providerKey: string | null;
  externalRecordId: string | null;
}

/**
 * 采集主流程：先拿结果，ok=false 时只展示可读错误且**不调用任何 Capture API**；
 * ok=true 时才发送并打开预览。错误文案不包含 capability 或完整页面内容。
 */
export async function runCaptureFlow(deps: CaptureFlowDeps): Promise<void> {
  deps.setStatus('正在读取当前页面…');
  const result = await deps.getCaptureResult();
  if (!result.ok) {
    // 采集失败：不创建会话、不加条目、不打开预览。
    deps.setStatus(result.message);
    return;
  }
  try {
    deps.setStatus('正在发送到本机 OfferFlow…');
    const session = await deps.createSession();
    await deps.addItem(session.id, {
      captureMethod: result.capture.captureMethod,
      sourceUrl: result.capture.sourceUrl ?? deps.fallbackSourceUrl(),
      pageTitle: result.capture.pageTitle,
      visibleText: result.capture.visibleText,
      recognizedFields: result.capture.recognizedFields,
      extractionMetadata: result.capture.extractionMetadata,
      providerKey: result.capture.providerKey,
      externalRecordId: result.capture.externalRecordId,
    });
    await deps.openPreview(session.id);
    deps.setStatus('已发送，请在打开的 OfferFlow 页面中确认。');
  } catch (error) {
    if (deps.isOfflineError(error)) {
      deps.setStatus('OfferFlow 未启动：请先在本机启动 OfferFlow（http://127.0.0.1:17365），再重试。');
      return;
    }
    deps.setStatus(`采集失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
}
