/**
 * OfferFlow v0.9 — Provider-neutral Search types.
 *
 * Task: T024 (SearchProviderAdapter interface + Provider-neutral types)
 * Contract: specs/001-daily-job-hunter/contracts/search-provider.md v2.0
 *
 * Key design decisions:
 *  - No DailySearchPlanVersion dependency — adapter accepts SearchProviderRequest.
 *  - Tavily DTO only at adapter boundary (not in these types).
 *  - evidenceLevel is always 'SEARCH_EVIDENCE' from the provider (Phase 3 constraint).
 *  - sourcePolicy is NOT set by the provider — added by Source Policy (Phase 4).
 */

// ── Query input ──────────────────────────────────────────────────────────────

/** A single expanded search query with tracking key. */
export interface SearchQuery {
  /** 组合后的搜索词（如 "苏州 前端工程师 招聘"） */
  query: string;
  /** Query 唯一键（如 "苏州×前端开发×React"），用于覆盖追踪 */
  queryKey: string;
  /** 城市 */
  city: string;
  /** 岗位方向 */
  roleDirection: string;
  /** 关键词 */
  keyword: string;
  /** 关键词来源 */
  keywordSource: 'base' | 'expanded';
}

// ── Provider-neutral request / config ────────────────────────────────────────

/**
 * Provider-neutral configuration scoped to one SearchProvider.
 *
 * Mapped from DailySearchPlanVersion.sourceConfigs[n] when T021 lands.
 * Until then this is the canonical adapter input.
 */
export interface SearchProviderConfig {
  /** Max results per query (provider default if omitted). */
  maxResults?: number;
  /** Provider-specific parameters (e.g. { searchDepth: 'basic', country: 'china' } for Tavily). */
  params?: Record<string, unknown>;
}

/**
 * Provider-neutral search request.
 *
 * Contains pre-expanded queries, provider configuration, and an abort signal.
 * The adapter does NOT know about DailySearchPlanVersion.
 */
export interface SearchProviderRequest {
  queries: SearchQuery[];
  config: SearchProviderConfig;
  signal: AbortSignal;
}

// ── Search evidence output ───────────────────────────────────────────────────

/**
 * Provider-neutral Search Evidence item.
 *
 * Based on Tavily / Brave common minimal semantics. Provider-specific fields
 * (images, answer, raw_content) do NOT enter this type.
 *
 * evidenceLevel is always 'SEARCH_EVIDENCE' — the provider only discovers URLs
 * and snippets. FULL_EVIDENCE requires Content Acquisition (Phase 4) or
 * Manual Capture.
 */
export interface SearchEvidenceItem {
  /** Search Provider identifier (e.g. 'tavily'). */
  provider: string;
  /** Search query text. */
  query: string;
  /** Provider request / trace ID (if available). */
  providerRequestId?: string;
  /** Result title. */
  title: string;
  /** Result URL. */
  url: string;
  /** Search snippet / content fragment (Provider Output — NOT a full JD). */
  content: string;
  /** Source domain parsed from url. */
  domain: string;
  /** Provider relevance score (if available). */
  providerScore?: number;
  /** Publication date (if available). */
  publishedAt?: string;
  /** Search timestamp (epoch ms). */
  searchedAt: number;
  /** Evidence level — always SEARCH_EVIDENCE from the provider. */
  evidenceLevel: 'SEARCH_EVIDENCE';
  /** Minimal provider metadata (response_time, query echo, etc.). */
  providerMetadata?: Record<string, unknown>;
}

// ── Provider result ──────────────────────────────────────────────────────────

/** Complete result from a SearchProviderAdapter.search() call. */
export interface SearchProviderResult {
  items: SearchEvidenceItem[];
  coverage: SearchCoverage;
  providerMeta: SearchProviderMeta;
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/** Search coverage summary — maps query-level results. */
export interface SearchCoverage {
  queriesCompleted: number;
  queriesFailed: number;
  failedScopes: FailedScope[];
  queryResults: QueryCoverageResult[];
}

export interface QueryCoverageResult {
  queryKey: string;
  status: 'COMPLETED' | 'FAILED' | 'VALID_EMPTY';
  resultsReturned: number;
  errorCode?: SearchProviderErrorCode;
  errorMessage?: string;
}

export interface FailedScope {
  queryKey: string;
  errorCode: SearchProviderErrorCode;
  message: string;
}

// ── Provider meta ────────────────────────────────────────────────────────────

export interface SearchProviderMeta {
  /** 物理 HTTP 请求总数（含 retry 后的额外 attempt），与 logical query 计数分层。 */
  requestsMade: number;
  /** 本次 provider 调用中发生的 retry 次数（物理 attempt 超出 logical query 的部分）。 */
  retriesUsed?: number;
  creditsUsed?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  cost?: ProviderCost;
}

export interface ProviderCost {
  currency: string;
  amount: number;
  source: string;
}

// ── Error codes ──────────────────────────────────────────────────────────────

/**
 * Provider-neutral search error codes.
 *
 * VALID_EMPTY (HTTP 200 + valid JSON + results=[]) is deliberately not an error
 * — it's a successful search that returned no results. All other codes represent
 * failures that must NOT be silently collapsed to "0 results".
 */
export type SearchProviderErrorCode =
  | 'VALID_EMPTY'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'USAGE_LIMIT'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'PROVIDER_UNAVAILABLE';
