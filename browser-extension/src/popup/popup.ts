import { addCaptureItem, buildPreviewUrl, createCaptureSession, OfferFlowNotRunningError } from '../api/radarCaptureClient';
import { runCaptureFlow } from '../content/captureFlow';
import { failureMessage, normalizeInjectionResult, type PageCaptureExecutionResult } from '../content/captureResult';

/** 注入文件路径（相对扩展根目录），由 build.mjs 预构建为自包含 IIFE。 */
const INJECTED_CAPTURE_FILE = 'src/content/injectedCapture.js';
const BATCH_CAPTURE_FILE = 'src/content/batchCapture.js';

/** 当前标签页是否为 BOSS 列表页（/web/geek/jobs）——走「批量选卡」而非单页采集。 */
function isBossListPage(url: string | undefined): boolean {
  if (url === undefined) return false;
  try {
    const parsed = new URL(url);
    return (parsed.hostname === 'www.zhipin.com' || parsed.hostname.endsWith('.zhipin.com'))
      && /\/web\/geek\/jobs?/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const statusEl = document.querySelector<HTMLParagraphElement>('#status');
const captureButton = document.querySelector<HTMLButtonElement>('#capture-button');

function setStatus(message: string): void {
  if (statusEl !== null) statusEl.textContent = message;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab === undefined || tab.id === undefined) {
    throw new Error('未找到当前活动标签页');
  }
  return tab;
}

/**
 * 两步自包含注入：
 * 1. files 注入预构建的自包含提取脚本，结果写入隔离世界约定全局；
 * 2. 一段只引用页面全局的 func 读取并清除该全局。
 * 任一步失败、或结果非法，都归一化为 SCRIPT_EXECUTION_FAILED，不产生 TypeError。
 */
async function readCaptureResult(tabId: number): Promise<PageCaptureExecutionResult> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [INJECTED_CAPTURE_FILE] });
  } catch {
    return { ok: false, code: 'SCRIPT_EXECUTION_FAILED', message: failureMessage('SCRIPT_EXECUTION_FAILED') };
  }
  let injections: unknown;
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const holder = window as unknown as Record<string, unknown>;
        const key = '__OFFERFLOW_CAPTURE_RESULT__';
        const value = holder[key] ?? null;
        delete holder[key];
        return value;
      },
    });
  } catch {
    return { ok: false, code: 'SCRIPT_EXECUTION_FAILED', message: failureMessage('SCRIPT_EXECUTION_FAILED') };
  }
  return normalizeInjectionResult(injections);
}

async function injectBatchSelect(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [BATCH_CAPTURE_FILE] });
    return true;
  } catch {
    setStatus('无法在当前页面开启批量选卡（可能是受限页面）。');
    return false;
  }
}

async function handleCaptureClick(): Promise<void> {
  if (captureButton !== null) captureButton.disabled = true;
  try {
    const tab = await getActiveTab();
    // BOSS 列表页：分流到「手动批量选卡 + 串行右侧详情采集」。job_detail/其他页：单页采集。
    if (isBossListPage(tab.url)) {
      const injected = await injectBatchSelect(tab.id!);
      if (injected) window.close();
      return;
    }
    await runCaptureFlow({
      getCaptureResult: () => readCaptureResult(tab.id!),
      fallbackSourceUrl: () => tab.url ?? null,
      createSession: async () => (await createCaptureSession('browser')).session,
      addItem: (sessionId, payload) => addCaptureItem(sessionId, payload).then(() => undefined),
      openPreview: async (sessionId) => {
        await chrome.tabs.create({ url: buildPreviewUrl(sessionId) });
      },
      setStatus,
      isOfflineError: (error) => error instanceof OfferFlowNotRunningError,
    });
  } catch (error) {
    setStatus(`采集失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    if (captureButton !== null) captureButton.disabled = false;
  }
}

captureButton?.addEventListener('click', () => {
  void handleCaptureClick();
});
