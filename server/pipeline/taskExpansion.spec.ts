/**
 * OfferFlow v0.9 — Query Expansion + Budget 控制 tests.
 *
 * Task: T027
 *
 * Covers:
 *  - Basic expansion (cities × directions × baseKeywords)
 *  - Deduplication (case-insensitive)
 *  - Budget cap (maxQueriesPerRun)
 *  - Expanded keyword quota (maxExpandedKeywords)
 *  - High-value selection (base before expanded)
 *  - Cartesian product prevention (4 cities × 3 keywords × 5 expanded = 60 → capped)
 */

import { describe, it, expect } from 'vitest';
import { expandQueries } from './taskExpansion';

describe('expandQueries', () => {
  it('basic expansion: cities × directions × baseKeywords', () => {
    const result = expandQueries({
      cities: ['苏州', '无锡'],
      roleDirections: ['前端开发', '全栈'],
      baseKeywords: ['React', 'TypeScript'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });

    // 2 cities × 2 directions × 2 keywords = 8
    expect(result).toHaveLength(8);

    // All should be base keywords
    for (const r of result) {
      expect(r.keywordSource).toBe('base');
    }
  });

  it('generates expected query format', () => {
    const result = expandQueries({
      cities: ['苏州'],
      roleDirections: ['前端开发'],
      baseKeywords: ['React'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });

    expect(result).toHaveLength(1);
    expect(result[0].query).toBe('苏州 React 前端开发 招聘');
    expect(result[0].queryKey).toBe('苏州×前端开发×React');
    expect(result[0].city).toBe('苏州');
    expect(result[0].roleDirection).toBe('前端开发');
    expect(result[0].keyword).toBe('React');
  });

  it('deduplicates identical queries case-insensitive', () => {
    const result = expandQueries({
      cities: ['苏州', '苏州'],   // duplicate city
      roleDirections: ['前端'],
      baseKeywords: ['React', 'react'], // case-insensitive duplicate
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });

    // After dedupe: only 1 unique (苏州 × 前端 × React)
    expect(result).toHaveLength(1);
    expect(result[0].query).toBe('苏州 React 前端 招聘');
  });

  it('caps at maxQueriesPerRun', () => {
    const result = expandQueries({
      cities: ['苏州', '无锡', '上海', '杭州'],
      roleDirections: ['前端开发', '全栈', 'AI应用'],
      baseKeywords: ['React', 'TypeScript', 'Vue', 'Node.js', 'Python'],
      maxQueriesPerRun: 10,
      maxExpandedKeywords: 0,
    });

    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('base keywords take priority over expanded keywords', () => {
    const result = expandQueries({
      cities: ['苏州'],
      roleDirections: ['前端'],
      baseKeywords: ['React', 'TypeScript'],
      expandedKeywords: ['Next.js', 'Vue', 'Angular'],
      maxQueriesPerRun: 3,          // only 3 slots
      maxExpandedKeywords: 10,
    });

    expect(result).toHaveLength(3);

    // First 2 should be base keywords, last 1 expanded
    const sources = result.map((r) => r.keywordSource);
    expect(sources).toEqual(['base', 'base', 'expanded']);
  });

  it('respects maxExpandedKeywords quota', () => {
    const result = expandQueries({
      cities: ['苏州'],
      roleDirections: ['前端'],
      baseKeywords: ['React'],
      expandedKeywords: ['Next.js', 'Vue', 'Angular', 'Svelte', 'Solid'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 2,       // only 2 expanded keywords used
    });

    // 1 base + 2 expanded = 3
    expect(result).toHaveLength(3);

    const expanded = result.filter((r) => r.keywordSource === 'expanded');
    expect(expanded).toHaveLength(2);
    expect(expanded[0].keyword).toBe('Next.js');
    expect(expanded[1].keyword).toBe('Vue');
  });

  it('prevents Cartesian product explosion', () => {
    // 4 cities × 3 directions × (5 base + 5 expanded) = 120 potential
    // Should be capped at maxQueriesPerRun
    const result = expandQueries({
      cities: ['苏州', '无锡', '上海', '杭州'],
      roleDirections: ['前端开发', '全栈', 'AI应用'],
      baseKeywords: ['React', 'TypeScript', 'Vue', 'Node.js', 'Python'],
      expandedKeywords: ['Next.js', 'Svelte', 'Go', 'Rust', 'GraphQL'],
      maxQueriesPerRun: 30,
      maxExpandedKeywords: 5,
    });

    // 4×3×(5+5) = 120 raw; capped at 30
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for empty input', () => {
    const result = expandQueries({
      cities: [],
      roleDirections: ['前端'],
      baseKeywords: ['React'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });
    expect(result).toHaveLength(0);
  });

  it('returns empty array when all inputs are empty', () => {
    const result = expandQueries({
      cities: [],
      roleDirections: [],
      baseKeywords: [],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });
    expect(result).toHaveLength(0);
  });

  it('every queryKey is unique', () => {
    const result = expandQueries({
      cities: ['苏州', '无锡', '上海'],
      roleDirections: ['前端开发', '全栈'],
      baseKeywords: ['React', 'TypeScript', 'Vue'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 0,
    });

    const keys = result.map((r) => r.queryKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('handles expandedKeywords undefined / empty', () => {
    const result = expandQueries({
      cities: ['苏州'],
      roleDirections: ['前端'],
      baseKeywords: ['React'],
      maxQueriesPerRun: 100,
      maxExpandedKeywords: 5,
      // expandedKeywords omitted
    });

    expect(result).toHaveLength(1);
    expect(result[0].keywordSource).toBe('base');
  });
});
