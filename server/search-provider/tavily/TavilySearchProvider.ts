/**
 * OfferFlow v0.9 — Tavily Search Provider (P0 implementation).
 *
 * Task: T026
 * Spec: specs/001-daily-job-hunter/spec.md §FR-009, FR-010
 * Contract: specs/001-daily-job-hunter/contracts/search-provider.md v2.0 §Tavily Provider
 *
 * P0 scope: Tavily /search endpoint ONLY.
 *  - Tavily Crawl / Extract / Map are NOT in P0 scope.
 *  - All search results default to evidenceLevel = 'SEARCH_EVIDENCE'.
 *  - FULL_EVIDENCE requires Content Acquisition (Phase 4) or Manual Capture.
 *
 * Constraints:
 *  - search_depth = 'basic' (1 credit per search)
 *  - country = 'china'
 *  - include_usage = true
 *  - include_raw_content = false
 *  - auto_parameters is BANNED (never sent)
 *  - Tavily-specific DTO stays inside this module and tavilyFieldMapping.ts
 */

import type { SearchProviderAdapter } from '../SearchProviderAdapter';
import type {
  SearchCoverage,
  SearchEvidenceItem,
  SearchProviderErrorCode,
  SearchProviderRequest,
  SearchProviderResult,
} from '../types';
import { buildTavilyRequestBody, mapTavilyResults, type TavilySearchResponse } from './tavilyFieldMapping';
import { TokenBucketRateLimiter } from './tavilyRateLimiter';

// ── Config ───────────────────────────────────────────────────────────────────

export interface TavilyProviderConfig {
  /** Function that resolves the Tavily API key (Bearer token). */
  apiKeyResolver: () => string;
  /** Base URL (default: https://api.tavily.com). */
  baseUrl?: string;
  /** Request timeout in ms (default: 30_000). */
  timeout?: number;
  /** Max results per query (default: 10, clamped by Tavily to 20). */
  defaultMaxResults?: number;
  /** Rate limiter. If omitted, a default bucket (10 tokens, 1/sec refill) is used. */
  rateLimiter?: TokenBucketRateLimiter;
  /** Fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
  /** Backoff 睡眠（测试可注入 no-op；默认真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 单次 retry 前的退避延迟（测试可注入固定值；默认 800–1200ms 抖动）。 */
  backoffDelayMs?: () => number;
}

const TAVILY_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_PATH = '/search';
/** 每 logical query 最多 1 次原始请求 + 1 次 bounded retry（禁止第三次 attempt）。 */
const MAX_ATTEMPTS_PER_QUERY = 2;
const BACKOFF_MIN_MS = 800;
const BACKOFF_MAX_MS = 1200;

/**
 * 有明确瞬时传输语义的 undici/Node 错误码（仅用于 retry 判定，不进入持久化）。
 * 覆盖真实已出现的 UND_ERR_CONNECT_TIMEOUT 与 socket/connect/DNS 传输失败。
 */
const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * 识别瞬时传输错误：仅依据 Node/undici 的 `err.cause.code` taxonomy。
 * 不做 message 模糊匹配，避免误伤语义不明的异常；AUTH/400/quota/429 均不在此列。
 */
function isTransientTransportError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const cause = (err as { cause?: unknown }).cause;
  if (cause === null || typeof cause !== 'object') return false;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_TRANSPORT_CODES.has(code);
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class TavilySearchProvider implements SearchProviderAdapter {
  readonly providerKey = 'tavily';
  readonly providerVersion = '1.0.0';

  private readonly apiKeyResolver: () => string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly defaultMaxResults: number;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoffDelayMs: () => number;

  constructor(config: TavilyProviderConfig) {
    this.apiKeyResolver = config.apiKeyResolver;
    this.baseUrl = config.baseUrl ?? TAVILY_BASE_URL;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.defaultMaxResults = config.defaultMaxResults ?? DEFAULT_MAX_RESULTS;
    this.rateLimiter = config.rateLimiter ?? new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1,
      refillInterval: 1000,
    });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.backoffDelayMs = config.backoffDelayMs
      ?? (() => BACKOFF_MIN_MS + Math.floor(Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS)));
  }

  async search(request: SearchProviderRequest): Promise<SearchProviderResult> {
    const items: SearchEvidenceItem[] = [];
    const queryResults: SearchCoverage['queryResults'] = [];
    const failedScopes: SearchCoverage['failedScopes'] = [];
    let queriesCompleted = 0;
    let queriesFailed = 0;
    let requestsMade = 0;
    let retriesUsed = 0;
    let totalCreditsUsed = 0;

    for (let i = 0; i < request.queries.length; i++) {
      if (request.signal.aborted) break;
      const sq = request.queries[i];

      const { result, attempts } = await this.searchSingle(sq.query, request, i);
      // 物理 HTTP attempt 与 logical query 分层：attempts 只计入 provider-local
      // requestsMade / retriesUsed，不改变 logical query 计数
      // （queriesCompleted / queriesFailed / failedScopes 仍按 query 统计）。
      requestsMade += attempts;
      retriesUsed += Math.max(0, attempts - 1);

      if (result.type === 'success') {
        queriesCompleted++;
        if (result.items.length > 0) {
          items.push(...result.items);
          queryResults.push({
            queryKey: sq.queryKey,
            status: 'COMPLETED',
            resultsReturned: result.items.length,
          });
        } else {
          queryResults.push({
            queryKey: sq.queryKey,
            status: 'VALID_EMPTY',
            resultsReturned: 0,
            errorCode: 'VALID_EMPTY',
            errorMessage: '搜索成功但无结果',
          });
        }
        totalCreditsUsed += result.creditsUsed ?? 0;
      } else {
        queriesFailed++;
        queryResults.push({
          queryKey: sq.queryKey,
          status: 'FAILED',
          resultsReturned: 0,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
        failedScopes.push({
          queryKey: sq.queryKey,
          errorCode: result.errorCode,
          message: result.errorMessage,
        });
      }
    }

    return {
      items,
      coverage: {
        queriesCompleted,
        queriesFailed,
        failedScopes,
        queryResults,
      },
      providerMeta: {
        requestsMade,
        retriesUsed,
        creditsUsed: totalCreditsUsed > 0 ? totalCreditsUsed : undefined,
      },
    };
  }

  // ── Single query execution ──────────────────────────────────────────────

  private async searchSingle(
    query: string,
    request: SearchProviderRequest,
    requestIndex: number,
  ): Promise<{ result: SingleQueryResult; attempts: number }> {
    // 速率限制（每 logical query 消费一次，不因 retry 额外消费）。
    if (!this.rateLimiter.consume()) {
      return {
        result: {
          type: 'error',
          errorCode: 'RATE_LIMITED',
          errorMessage: `Tavily 频率限制：请求 ${requestIndex + 1} 被本地 Token Bucket 拒绝`,
        },
        attempts: 0,
      };
    }

    const maxResults = (request.config.maxResults ?? this.defaultMaxResults);
    const body = buildTavilyRequestBody(query, maxResults);
    const apiKey = this.apiKeyResolver();
    const url = `${this.baseUrl}${SEARCH_PATH}`;

    let attempts = 0;
    while (attempts < MAX_ATTEMPTS_PER_QUERY) {
      attempts++;
      const outcome = await this.attemptOnce(url, apiKey, body, query, request);

      if (outcome.type === 'success') {
        return { result: outcome, attempts };
      }
      // 非瞬时传输错误 / 已耗尽全部 attempt → 直接返回；只有瞬时传输错误且仍有余量才 retry。
      if (!outcome.transportRetryable || attempts >= MAX_ATTEMPTS_PER_QUERY) {
        return { result: outcome, attempts };
      }
      await this.backoff();
    }

    // 理论不可达（循环至少执行一次）；防御性兜底，避免 TS 收窄报错。
    return {
      result: { type: 'error', errorCode: 'TIMEOUT', errorMessage: `Tavily 请求已取消: ${query}` },
      attempts,
    };
  }

  private async attemptOnce(
    url: string,
    apiKey: string,
    body: Record<string, unknown>,
    query: string,
    request: SearchProviderRequest,
  ): Promise<SingleQueryResult> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), this.timeout);
    const combinedSignal =
      request.signal.aborted
        ? AbortSignal.abort()
        : AbortSignal.any([request.signal, abortController.signal]);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      clearTimeout(timeoutId);

      return await this.handleResponse(response, query);
    } catch (err) {
      clearTimeout(timeoutId);

      if (request.signal.aborted || abortController.signal.aborted) {
        // Distinguish timeout from external abort
        if (abortController.signal.aborted && !request.signal.aborted) {
          return {
            type: 'error',
            errorCode: 'TIMEOUT',
            errorMessage: `Tavily 请求超时 (${this.timeout}ms): ${query}`,
          };
        }
        return {
          type: 'error',
          errorCode: 'TIMEOUT',
          errorMessage: `Tavily 请求已取消: ${query}`,
        };
      }

      // 仅瞬时传输失败（undici cause.code）允许在 searchSingle 内做一次 bounded retry。
      return {
        type: 'error',
        errorCode: 'NETWORK_ERROR',
        errorMessage: `Tavily 网络错误: ${err instanceof Error ? err.message : String(err)}`,
        transportRetryable: isTransientTransportError(err),
      };
    }
  }

  /** 单次 bounded backoff（800–1200ms jitter），睡眠/延迟均可注入，避免测试真实等待。 */
  private async backoff(): Promise<void> {
    const delay = this.backoffDelayMs();
    if (delay > 0) {
      await this.sleep(delay);
    }
  }

  private async handleResponse(
    response: Response,
    query: string,
  ): Promise<SingleQueryResult> {
    // 401 — Auth error
    if (response.status === 401) {
      return {
        type: 'error',
        errorCode: 'AUTH_ERROR',
        errorMessage: `Tavily API Key 无效 (HTTP 401): ${query}`,
      };
    }

    // 429 — Rate limited by provider
    if (response.status === 429) {
      return {
        type: 'error',
        errorCode: 'RATE_LIMITED',
        errorMessage: `Tavily 频率限制 (HTTP 429): ${query}`,
      };
    }

    // 432 — Usage Limit Exceeded (monthly quota exhausted)
    if (response.status === 432) {
      return {
        type: 'error',
        errorCode: 'USAGE_LIMIT',
        errorMessage: `Tavily 月度额度耗尽 (HTTP 432): ${query}`,
      };
    }

    // 5xx — Provider unavailable
    if (response.status >= 500) {
      return {
        type: 'error',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: `Tavily 服务不可用 (HTTP ${response.status}): ${query}`,
      };
    }

    // Non-200
    if (!response.ok) {
      return {
        type: 'error',
        errorCode: 'NETWORK_ERROR',
        errorMessage: `Tavily 返回异常状态码 HTTP ${response.status}: ${query}`,
      };
    }

    // Parse JSON body
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        type: 'error',
        errorCode: 'MALFORMED_RESPONSE',
        errorMessage: `Tavily 响应不是合法 JSON: ${query}`,
      };
    }

    // Validate response shape
    if (!isTavilySearchResponse(body)) {
      return {
        type: 'error',
        errorCode: 'MALFORMED_RESPONSE',
        errorMessage: `Tavily 响应结构不符预期: ${query}`,
      };
    }

    // Map to provider-neutral items
    const items = mapTavilyResults(body, Date.now());
    const creditsUsed = body.usage?.credit_used;

    return { type: 'success', items, creditsUsed };
  }
}

// ── Type guard ───────────────────────────────────────────────────────────────

function isTavilySearchResponse(body: unknown): body is TavilySearchResponse {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.query === 'string' &&
    Array.isArray(b.results)
  );
}

// ── Internal types ───────────────────────────────────────────────────────────

type SingleQueryResult =
  | { type: 'success'; items: SearchEvidenceItem[]; creditsUsed?: number }
  | { type: 'error'; errorCode: SearchProviderErrorCode; errorMessage: string; transportRetryable?: boolean };
