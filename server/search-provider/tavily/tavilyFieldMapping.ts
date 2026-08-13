/**
 * OfferFlow v0.9 — Tavily API → SearchEvidenceItem field mapping.
 *
 * Task: T026
 * Contract: specs/001-daily-job-hunter/contracts/search-provider.md v2.0 §Tavily → SearchEvidenceItem
 *
 * This is the ONLY file where Tavily-specific DTO fields are mapped to
 * Provider-neutral SearchEvidenceItem. No other module imports Tavily types.
 */

import type { SearchEvidenceItem } from '../types';

// ── Tavily-specific DTO (adapter boundary — NOT exported beyond this module) ─

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content: string | null;
  published_date?: string;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  response_time: number;
  images?: unknown[];
  usage?: {
    credit_used: number;
  };
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Map a single Tavily result to a Provider-neutral SearchEvidenceItem.
 *
 * @param result — raw Tavily result from the API response.
 * @param query — the search query text that produced this result.
 * @param searchedAt — epoch ms timestamp of the search.
 * @returns Provider-neutral evidence item (evidenceLevel = 'SEARCH_EVIDENCE').
 */
export function mapTavilyResult(
  result: TavilySearchResult,
  query: string,
  searchedAt: number,
): SearchEvidenceItem {
  const domain = extractDomain(result.url);

  return {
    provider: 'tavily',
    query,
    title: result.title,
    url: result.url,
    content: result.content,
    domain,
    providerScore: result.score,
    publishedAt: result.published_date,
    searchedAt,
    evidenceLevel: 'SEARCH_EVIDENCE',
  };
}

/**
 * Map all Tavily results from a search response.
 *
 * raw_content is deliberately NOT mapped — it's excluded per Phase 3 constraint
 * (include_raw_content=false). If include_raw_content is enabled in the future,
 * a separate evidence level decision (T005, Phase 0) must precede any mapping.
 */
export function mapTavilyResults(
  response: TavilySearchResponse,
  searchedAt: number,
): SearchEvidenceItem[] {
  return response.results.map((r) => mapTavilyResult(r, response.query, searchedAt));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return 'unknown';
  }
}

// ── Request build ────────────────────────────────────────────────────────────

/**
 * Build a Tavily POST /search request body from a query string + config.
 *
 * Hardcoded constraints (Phase 3):
 *  - search_depth = 'basic' (1 credit per search)
 *  - country = 'china'
 *  - topic = 'general'
 *  - include_answer = false
 *  - include_raw_content = false
 *  - include_usage = true (get credit usage from response)
 *  - auto_parameters is NEVER included (Phase 3 ban)
 */
export function buildTavilyRequestBody(
  query: string,
  maxResults: number,
): Record<string, unknown> {
  return {
    query,
    search_depth: 'basic',
    country: 'china',
    topic: 'general',
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  };
}
