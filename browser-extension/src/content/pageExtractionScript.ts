/**
 * 历史入口保留：早期版本把本函数作为 chrome.scripting.executeScript({ func }) 注入，
 * 但注入后页面上下文没有模块闭包（selectAndExtract 等），会抛 ReferenceError 并使
 * executeScript 返回 result:null，导致 popup 读取 captureMethod 时崩溃。
 *
 * 现在改用自包含的 files 注入（见 ./injectedCapture 与 ./captureResult），本文件仅保留
 * 一个薄薄的纯函数转发，供单测直接使用；popup 不再引用它，也不再作为注入函数使用。
 */
import { buildPageCaptureResult, type PageCaptureExecutionResult } from './captureResult';

export function runPageExtraction(url: string, doc: Document): PageCaptureExecutionResult {
  return buildPageCaptureResult(url, doc);
}
