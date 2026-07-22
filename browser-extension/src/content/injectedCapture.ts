import { buildPageCaptureResult, type PageCaptureExecutionResult } from './captureResult';

/**
 * 仅由 popup 在用户点击后通过 chrome.scripting.executeScript({ files }) 注入执行一次。
 * 构建时（build.mjs）会把所有依赖打包进这个文件，注入后完全自包含，不依赖页面里不存在的
 * 模块闭包。结果写入隔离世界的约定全局，由后续一段自包含 func 注入读取。
 *
 * 边界：不常驻（非 content_scripts）、不轮询、不后台扫描、只读 document/location.href，
 * 不读取 cookie、localStorage、token 或浏览历史，也不执行页面提供的脚本。
 */
declare global {
  interface Window {
    __OFFERFLOW_CAPTURE_RESULT__?: PageCaptureExecutionResult;
  }
}

window.__OFFERFLOW_CAPTURE_RESULT__ = buildPageCaptureResult(window.location.href, document);

export {};
