/**
 * OfferFlow v0.9 — Query Expansion + Budget 控制.
 *
 * Task: T027
 * Spec: specs/001-daily-job-hunter/plan.md v3.0 §2.11 Query Expansion & Budget
 *
 * Pure function — no DB, no Scheduler, no SourceRun, no SearchPlan Repository.
 *
 * Expands cities × roleDirections × baseKeywords into deduplicated,
 * budget-capped SearchQuery[] suitable for feeding into SearchProviderAdapter.
 *
 * Key constraints:
 *  - NOT a Cartesian product — capped at maxQueriesPerRun.
 *  - Base keywords prioritized over expanded keywords.
 *  - Case-insensitive deduplication.
 *  - Each SearchQuery includes a queryKey for coverage tracking.
 */

import type { SearchQuery } from '../search-provider/types';
import type { QueryExpansionInput } from '../search-provider/SearchProviderAdapter';

/** Single raw query template before dedupe. */
interface RawQuery {
  query: string;
  queryKey: string;
  city: string;
  roleDirection: string;
  keyword: string;
  keywordSource: 'base' | 'expanded';
}

/**
 * Expand cities × roleDirections × keywords into a deduplicated, budget-capped
 * SearchQuery[] list.
 *
 * Algorithm:
 *   1. Generate raw queries from (cities × roleDirections × baseKeywords)
 *   2. Generate raw queries from (cities × roleDirections × expandedKeywords)
 *      capped at maxExpandedKeywords (first N after dedupe vs base).
 *   3. Deduplicate by case-insensitive query text.
 *   4. Cap total at maxQueriesPerRun (base first, then expanded).
 */
export function expandQueries(input: QueryExpansionInput): SearchQuery[] {
  const baseRaw = buildRawQueries(
    input.cities,
    input.roleDirections,
    input.baseKeywords,
    'base',
  );

  const expandedKeywords = (input.expandedKeywords ?? []).slice(0, input.maxExpandedKeywords);
  const expandedRaw = buildRawQueries(
    input.cities,
    input.roleDirections,
    expandedKeywords,
    'expanded',
  );

  // Base first, then expanded. Dedupe by case-insensitive query text.
  const seen = new Set<string>();
  const result: SearchQuery[] = [];

  for (const raw of [...baseRaw, ...expandedRaw]) {
    if (result.length >= input.maxQueriesPerRun) break;

    const key = raw.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      query: raw.query,
      queryKey: raw.queryKey,
      city: raw.city,
      roleDirection: raw.roleDirection,
      keyword: raw.keyword,
      keywordSource: raw.keywordSource,
    });
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRawQueries(
  cities: string[],
  roleDirections: string[],
  keywords: string[],
  keywordSource: 'base' | 'expanded',
): RawQuery[] {
  const raw: RawQuery[] = [];
  for (const city of cities) {
    for (const direction of roleDirections) {
      for (const keyword of keywords) {
        const query = `${city} ${keyword} ${direction} 招聘`;
        const queryKey = `${city}×${direction}×${keyword}`;
        raw.push({ query, queryKey, city, roleDirection: direction, keyword, keywordSource });
      }
    }
  }
  return raw;
}
