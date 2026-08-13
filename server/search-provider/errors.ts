/**
 * OfferFlow v0.9 — SearchProvider error code helpers.
 *
 * Task: T024
 * Contract: specs/001-daily-job-hunter/contracts/search-provider.md v2.0
 */

import type { SearchProviderErrorCode } from './types';

/**
 * Ordered list of all 9 error codes for validation.
 *
 * VALID_EMPTY appears first — it's technically a "success" status, not an error,
 * but it lives in the error code namespace for unified handling in coverage.
 */
export const SEARCH_PROVIDER_ERROR_CODES: readonly SearchProviderErrorCode[] = [
  'VALID_EMPTY',
  'AUTH_ERROR',
  'RATE_LIMITED',
  'USAGE_LIMIT',
  'TIMEOUT',
  'NETWORK_ERROR',
  'MALFORMED_RESPONSE',
  'PROVIDER_UNAVAILABLE',
] as const;

/** Error codes that may resolve on retry. */
const RETRYABLE: ReadonlySet<SearchProviderErrorCode> = new Set([
  'RATE_LIMITED',
  'TIMEOUT',
  'NETWORK_ERROR',
  'PROVIDER_UNAVAILABLE',
]);

/** Error codes that should stop the run immediately. */
const FATAL: ReadonlySet<SearchProviderErrorCode> = new Set([
  'AUTH_ERROR',
  'USAGE_LIMIT',
]);

/** VALID_EMPTY is not an error — it's a successful search with no results. */
export function isValidEmpty(code: SearchProviderErrorCode): boolean {
  return code === 'VALID_EMPTY';
}

/** Returns true if the error is transient and worth retrying. */
export function isRetryable(code: SearchProviderErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Returns true if the error is fatal and should stop the run. */
export function isFatal(code: SearchProviderErrorCode): boolean {
  return FATAL.has(code);
}

/** Human-readable label for each error code. */
export function errorCodeLabel(code: SearchProviderErrorCode): string {
  switch (code) {
    case 'VALID_EMPTY':
      return '搜索成功但无结果';
    case 'AUTH_ERROR':
      return 'API Key 无效或过期';
    case 'RATE_LIMITED':
      return '频率限制';
    case 'USAGE_LIMIT':
      return '月度额度耗尽';
    case 'TIMEOUT':
      return '请求超时';
    case 'NETWORK_ERROR':
      return '网络不可达';
    case 'MALFORMED_RESPONSE':
      return '响应格式异常';
    case 'PROVIDER_UNAVAILABLE':
      return 'Provider 服务不可用';
  }
}
