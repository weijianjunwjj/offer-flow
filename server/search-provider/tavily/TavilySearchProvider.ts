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
}

const TAVILY_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_PATH = '/search';

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
  }

  async search(request: SearchProviderRequest): Promise<SearchProviderResult> {
    const items: SearchEvidenceItem[] = [];
    const queryResults: SearchCoverage['queryResults'] = [];
    const failedScopes: SearchCoverage['failedScopes'] = [];
    let queriesCompleted = 0;
    let queriesFailed = 0;
    let requestsMade = 0;
    let totalCreditsUsed = 0;

    for (const sq of request.queries) {
      if (request.signal.aborted) break;

      const result = await this.searchSingle(sq.query, request, requestsMade);
      requestsMade++;

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
        creditsUsed: totalCreditsUsed > 0 ? totalCreditsUsed : undefined,
      },
    };
  }

  // ── Single query execution ──────────────────────────────────────────────

  private async searchSingle(
    query: string,
    request: SearchProviderRequest,
    requestIndex: number,
  ): Promise<SingleQueryResult> {
    // Rate limit check
    if (!this.rateLimiter.consume()) {
      return {
        type: 'error',
        errorCode: 'RATE_LIMITED',
        errorMessage: `Tavily 频率限制：请求 ${requestIndex + 1} 被本地 Token Bucket 拒绝`,
      };
    }

    const maxResults = (request.config.maxResults ?? this.defaultMaxResults);
    const body = buildTavilyRequestBody(query, maxResults);
    const apiKey = this.apiKeyResolver();
    const url = `${this.baseUrl}${SEARCH_PATH}`;

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

      return {
        type: 'error',
        errorCode: 'NETWORK_ERROR',
        errorMessage: `Tavily 网络错误: ${err instanceof Error ? err.message : String(err)}`,
      };
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
  | { type: 'error'; errorCode: SearchProviderErrorCode; errorMessage: string };
