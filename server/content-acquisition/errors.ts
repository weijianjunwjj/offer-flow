/**
 * v0.9 Phase 4C — Content Acquisition 错误模型（纯契约，无网络 / 无 DB）。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/plan.md §2.10
 *   specs/001-daily-job-hunter/tasks.md T035
 *   Phase 4C-2 Implementation Scope Lock v3
 *
 * 这些错误码是 transport / extraction / decoding 阶段的可区分失败语义，
 * 与「证据完整性验证」分离——fetch 失败 ≠ 证据不足，二者不属于同一判定维度。
 *
 * Phase 4C-1 已落地：BLOCKED_BY_POLICY / NOT_FOUND / TIMEOUT / NETWORK_ERROR /
 * UNSUPPORTED_CONTENT / PARSE_FAILED / REDIRECT_BLOCKED / SSRF_BLOCKED。
 *
 * Phase 4C-2 新增（Scope Lock v3）：
 *   - ACCESS_DENIED        —— HTTP 401 / 403 / 407（与 UNSUPPORTED_CONTENT 分离）
 *   - RESPONSE_TOO_LARGE   —— wire 或 decoded 字节数超限
 *   - UNSUPPORTED_CHARSET  —— 无法识别的 charset label
 *   - DECODE_FAILED        —— fatal 解码失败（禁 silent mojibake）
 */

export const CONTENT_FETCH_ERROR_CODES = [
  'BLOCKED_BY_POLICY',
  'ACCESS_DENIED',
  'NOT_FOUND',
  'TIMEOUT',
  'NETWORK_ERROR',
  'RESPONSE_TOO_LARGE',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_CHARSET',
  'DECODE_FAILED',
  'PARSE_FAILED',
  'REDIRECT_BLOCKED',
  'SSRF_BLOCKED',
] as const;

export type ContentFetchErrorCode = (typeof CONTENT_FETCH_ERROR_CODES)[number];

export interface ContentFetchError {
  /** 稳定、机器可读的错误码（status 级），供测试与未来重试 / 状态机判定。 */
  code: ContentFetchErrorCode;
  /**
   * 细粒度、稳定、机器可读的 reasonCode（在同一个 status 内部区分原因）。
   * 例如 RESPONSE_TOO_LARGE 下区分 wire_response_too_large / decoded_response_too_large。
   * Phase 4C-2 起始终填充；Phase 4C-1 既有契约（sourceEligibility 等）可省略。
   */
  reasonCode?: string;
  /** 人类可读的原因说明。 */
  reason: string;
}
