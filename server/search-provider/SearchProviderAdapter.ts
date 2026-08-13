/**
 * OfferFlow v0.9 — SearchProviderAdapter interface.
 *
 * Task: T024
 * Contract: specs/001-daily-job-hunter/contracts/search-provider.md v2.0
 *
 * This is the Provider-neutral adapter contract. Concrete providers (Tavily,
 * future Brave, etc.) implement this interface. Provider-specific DTOs stay
 * inside each adapter — the domain layer only sees SearchEvidenceItem.
 */

import type {
  SearchProviderRequest,
  SearchProviderResult,
  SearchQuery,
} from './types';

export type { SearchProviderRequest };

export interface SearchProviderAdapter {
  /** Provider identifier (e.g. 'tavily'). */
  readonly providerKey: string;
  /** Provider version (e.g. '1.0.0'). */
  readonly providerVersion: string;

  /**
   * Execute search across all queries in the request.
   *
   * @param request — pre-expanded queries + provider config + abort signal.
   * @returns Search evidence items + coverage + provider metadata.
   *
   * Constraints:
   *  - evidenceLevel is always 'SEARCH_EVIDENCE' (provider discovers, doesn't fetch).
   *  - Content Acquisition is a separate step (Phase 4).
   *  - Provider MUST distinguish VALID_EMPTY from actual failures.
   *  - Provider MUST NOT silently collapse errors to empty results.
   */
  search(request: SearchProviderRequest): Promise<SearchProviderResult>;
}

/**
 * Provider-agnostic search function type (for dependency injection in tests).
 */
export type SearchProviderFn = SearchProviderAdapter['search'];

/**
 * Expand a search plan into a deduplicated, budget-capped SearchQuery list.
 *
 * Pure function — no DB, no Scheduler, no SourceRun.
 * Implemented by pipeline/taskExpansion.ts (T027).
 */
export type QueryExpansionFn = (input: QueryExpansionInput) => SearchQuery[];

export interface QueryExpansionInput {
  cities: string[];
  roleDirections: string[];
  baseKeywords: string[];
  expandedKeywords?: string[];
  maxQueriesPerRun: number;
  maxExpandedKeywords: number;
}
