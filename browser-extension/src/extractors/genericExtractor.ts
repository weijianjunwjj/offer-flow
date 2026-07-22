import type { ExtractedPage } from './types';
import { extractCleanText } from './domText';

/**
 * 通用可见文本降级：BOSS 定向选择器未命中，或域名不是已知平台时使用。
 * 只做“可见文本”粗提取（跳过 script/style 与隐藏干扰节点），不承诺任何字段级解析——
 * recognizedFields 始终为 null，交给用户在预览页手工补全。
 */
export function extractGenericPage(doc: Document): ExtractedPage {
  return {
    pageTitle: doc.querySelector('title')?.textContent?.trim() ?? null,
    visibleText: extractCleanText(doc.body),
    recognizedFields: null,
  };
}
