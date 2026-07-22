import { selectAndExtract } from '../extractors/selectExtractor';
import type { CaptureMethod } from '../extractors/selectExtractor';
import type { ExtractedRecognizedFields } from '../extractors/types';

/** 采集成功时交给 popup 发送到本机 OfferFlow 的最小载荷。 */
export interface PageCapturePayload {
  captureMethod: CaptureMethod;
  sourceUrl: string | null;
  pageTitle: string | null;
  visibleText: string;
  recognizedFields: ExtractedRecognizedFields | null;
  /** 完整 rich extraction 旁注，最终写入服务端 raw_snapshot_json；不进入结构化八字段。 */
  extractionMetadata: Record<string, unknown> | null;
  /** 稳定岗位身份（§六）：用于服务端精确去重，不依赖 securityId/列表 query。 */
  providerKey: string | null;
  externalRecordId: string | null;
  /** 为真时禁止确认写入（§六，例如 list_panel 未取到稳定岗位 ID）。 */
  commitBlocked: boolean;
}

export type PageCaptureFailureCode =
  | 'UNSUPPORTED_PAGE'
  | 'EXTRACTION_FAILED'
  | 'EMPTY_PAGE_CONTENT'
  | 'SCRIPT_EXECUTION_FAILED';

/**
 * 采集执行结果判别联合：任何 null / undefined / 空注入结果 / 页面脚本异常都必须转成
 * ok:false 的可读错误，绝不返回裸 null，也不再在 popup 侧产生 TypeError。
 */
export type PageCaptureExecutionResult =
  | { ok: true; capture: PageCapturePayload }
  | { ok: false; code: PageCaptureFailureCode; message: string };

const FAILURE_MESSAGES: Record<PageCaptureFailureCode, string> = {
  UNSUPPORTED_PAGE: '当前页面不支持采集，请打开一个岗位详情页或包含可见文本的页面后重试。',
  EXTRACTION_FAILED: '页面结构解析失败，可在 OfferFlow 预览页手工补全字段。',
  EMPTY_PAGE_CONTENT: '当前页面没有可提取的可见文本，请确认页面已加载完成后重试。',
  SCRIPT_EXECUTION_FAILED: '无法在当前页面执行采集脚本（可能是浏览器内部页面或受限页面）。',
};

export function failureMessage(code: PageCaptureFailureCode): string {
  return FAILURE_MESSAGES[code];
}

function fail(code: PageCaptureFailureCode): PageCaptureExecutionResult {
  return { ok: false, code, message: FAILURE_MESSAGES[code] };
}

/**
 * 纯函数：读取传入的 URL 与 Document，产出判别联合结果。
 * - 无 body 的文档（浏览器内部页/受限页）→ UNSUPPORTED_PAGE；
 * - 提取过程抛异常 → EXTRACTION_FAILED（吞掉真实异常但不返回裸 null）；
 * - 无可见文本 → EMPTY_PAGE_CONTENT；
 * - 其余 → ok:true；字段缺失保持 null，绝不编造事实。
 * BOSS 列表页/详情页选择器未命中时由 selectAndExtract 降级为通用可见文本，仍返回 ok:true。
 */
export function buildPageCaptureResult(url: string, doc: Document): PageCaptureExecutionResult {
  if (doc === null || doc === undefined || doc.body === null || doc.body === undefined) {
    return fail('UNSUPPORTED_PAGE');
  }
  let extraction;
  try {
    extraction = selectAndExtract(url, doc);
  } catch {
    // 不泄露页面内容或异常细节，只返回可读错误码。
    return fail('EXTRACTION_FAILED');
  }
  if (extraction.page.visibleText.trim().length === 0) {
    return fail('EMPTY_PAGE_CONTENT');
  }
  // sourceUrl 优先用规范化的 job_detail 无 query URL（§六），使 list_panel 与独立详情页共享稳定来源身份，
  // 避免以 /web/geek/jobs 列表页 URL 建立错误来源记录。
  const fallbackUrl = url.length > 0 ? url : null;
  return {
    ok: true,
    capture: {
      captureMethod: extraction.captureMethod,
      sourceUrl: extraction.canonicalSourceUrl ?? fallbackUrl,
      pageTitle: extraction.page.pageTitle,
      visibleText: extraction.page.visibleText,
      recognizedFields: extraction.page.recognizedFields,
      extractionMetadata: extraction.metadata,
      providerKey: extraction.providerKey,
      externalRecordId: extraction.externalRecordId,
      commitBlocked: extraction.commitBlocked,
    },
  };
}

/**
 * 把 chrome.scripting.executeScript 返回的 InjectionResult[] 归一化为判别联合。
 * 覆盖：空数组、results[0] 缺失、results[0].result 为 null/undefined、结果结构不合法，
 * 全部转成 SCRIPT_EXECUTION_FAILED，不产生 TypeError。
 */
export function normalizeInjectionResult(injections: unknown): PageCaptureExecutionResult {
  const array = Array.isArray(injections) ? injections : [];
  if (array.length === 0) return fail('SCRIPT_EXECUTION_FAILED');
  const first: unknown = array[0];
  const result = first !== null && typeof first === 'object'
    ? (first as { result?: unknown }).result
    : undefined;
  if (result === null || result === undefined) return fail('SCRIPT_EXECUTION_FAILED');
  if (typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return fail('SCRIPT_EXECUTION_FAILED');
  }
  return result as PageCaptureExecutionResult;
}
