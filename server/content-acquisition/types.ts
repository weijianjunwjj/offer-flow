/**
 * v0.9 Phase 4C-1 — Content Acquisition 契约 DTO（纯类型，无实现）。
 *
 * 硬不变量：
 *   fetch success != FULL_EVIDENCE
 *
 * transport 成功、extraction 成功、完整性验证通过、evidence_upgrade 落库是四种不同语义。
 * 本契约只表达前三种的结构，绝不携带或改写 evidenceLevel；FULL_EVIDENCE 只能由后续
 * 显式 evidence_upgrade（或 Manual Capture）落库产生。
 */

import type { ContentFetchError } from './errors';

/**
 * 受限请求 DTO：`sourcePolicy` 被窄化为字面量 `'SEARCH_AND_FETCH'`，
 * 使调用方无法通过本类型绕过 Source Policy 构造 SEARCH_ONLY 请求。
 */
export interface ContentFetchRequest {
  url: string;
  normalizedDomain: string;
  sourcePolicy: 'SEARCH_AND_FETCH';
}

/**
 * 有界提取内容 DTO（最小字段集）。
 *
 * 刻意不含 rawHtml / raw_content：不把原始 HTML 暴露进业务层，也不在此阶段持久化。
 * plainText 仅代表未来实现可能产出的有界提取正文。
 */
export interface ExtractedContent {
  title: string;
  plainText: string;
  canonicalUrl: string | null;
  contentType: string | null;
}

/** JD 完整性 / 证据验证状态：PASS = 完整、FAIL = 不完整。 */
export type EvidenceValidationStatus = 'PASS' | 'FAIL';

/**
 * JD 完整性 / 证据验证结果 DTO。
 * 这是「证据充分性」判定，不是岗位质量 / 匹配度分析。
 */
export interface EvidenceValidationResult {
  status: EvidenceValidationStatus;
  /** 稳定、机器可读的 reason code（如 'jd_complete' / 'jd_incomplete_missing_title'）。 */
  reasonCode: string;
}

/**
 * 判别联合：transport/extraction 状态 与 完整性验证状态 分离。
 *
 *   - FETCHED 分支携带 ExtractedContent + EvidenceValidationResult；
 *   - 其余分支都是 transport/extraction 失败，携带对应错误码。
 *
 * 全联合没有任何 evidenceLevel / success 字段——fetch 成功不编码为 FULL_EVIDENCE。
 */
export type FetchResult =
  | { status: 'FETCHED'; content: ExtractedContent; validation: EvidenceValidationResult }
  | { status: 'BLOCKED_BY_POLICY'; error: ContentFetchError }
  | { status: 'ACCESS_DENIED'; error: ContentFetchError }
  | { status: 'NOT_FOUND'; error: ContentFetchError }
  | { status: 'TIMEOUT'; error: ContentFetchError }
  | { status: 'NETWORK_ERROR'; error: ContentFetchError }
  | { status: 'RESPONSE_TOO_LARGE'; error: ContentFetchError }
  | { status: 'UNSUPPORTED_CONTENT'; error: ContentFetchError }
  | { status: 'UNSUPPORTED_CHARSET'; error: ContentFetchError }
  | { status: 'DECODE_FAILED'; error: ContentFetchError }
  | { status: 'PARSE_FAILED'; error: ContentFetchError }
  | { status: 'REDIRECT_BLOCKED'; error: ContentFetchError }
  | { status: 'SSRF_BLOCKED'; error: ContentFetchError };

/**
 * 语义精确为「验证认为内容足以支撑一次未来的 evidence_upgrade 尝试」，
 * 而不是「FULL_EVIDENCE 已经写入」。返回 true 仅代表 PASS，不产生任何证据等级变化。
 */
export function isEvidenceUpgradeEligible(validation: EvidenceValidationResult): boolean {
  return validation.status === 'PASS';
}
