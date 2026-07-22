import { addCaptureItem, buildPreviewUrl, createCaptureSession, OfferFlowNotRunningError } from '../api/radarCaptureClient';
import { isBatchSubmitMessage, type BatchSubmitResponse } from '../content/batchMessages';
import type { BatchSubmitItem } from '../content/batchPayload';

/**
 * V8-2 MV3 background service worker。职责严格限定为「最终 API 提交」：
 * - 接收页面注入脚本采集完成后的整批结果；
 * - createSession 一次；按 selectionOrder 逐项 addItem；
 * - 单项 addItem 失败独立记录，不重试整批；
 * - 打开一个 preview 预览页；返回 sessionId / submittedCount / failedToSubmitCount。
 * SW 不负责长时间队列运行（滚动/点击/观察都在前台页面脚本内完成）。
 */

async function submitBatch(items: BatchSubmitItem[]): Promise<BatchSubmitResponse> {
  if (items.length === 0) return { ok: false, code: 'NO_ITEMS', error: '无可提交项' };

  let sessionId: string;
  try {
    sessionId = (await createCaptureSession('browser')).session.id;
  } catch (error) {
    if (error instanceof OfferFlowNotRunningError) return { ok: false, code: 'OFFERFLOW_NOT_RUNNING' };
    return { ok: false, code: 'SUBMIT_ERROR', error: error instanceof Error ? error.message : '创建会话失败' };
  }

  let submittedCount = 0;
  let failedToSubmitCount = 0;
  const ordered = [...items].sort((a, b) => a.selectionOrder - b.selectionOrder);
  for (const item of ordered) {
    try {
      await addCaptureItem(sessionId, {
        captureMethod: item.captureMethod,
        sourceUrl: item.sourceUrl,
        pageTitle: item.pageTitle,
        visibleText: item.visibleText,
        recognizedFields: item.recognizedFields,
        extractionMetadata: item.extractionMetadata,
        providerKey: item.providerKey,
        externalRecordId: item.externalRecordId,
      });
      submittedCount += 1;
    } catch {
      // 单项失败独立记录，继续后续项，不重试整批。
      failedToSubmitCount += 1;
    }
  }

  const previewUrl = buildPreviewUrl(sessionId);
  try {
    await chrome.tabs.create({ url: previewUrl });
  } catch {
    // 打开预览失败不影响已提交结果，仍回传 sessionId 供 UI 提示。
  }
  return { ok: true, sessionId, previewUrl, submittedCount, failedToSubmitCount };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isBatchSubmitMessage(message)) return false;
  submitBatch(message.items)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => sendResponse({ ok: false, code: 'SUBMIT_ERROR', error: error instanceof Error ? error.message : '未知错误' }));
  return true; // 异步 sendResponse
});

export {};
