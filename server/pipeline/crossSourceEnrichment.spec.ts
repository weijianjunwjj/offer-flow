/**
 * v0.9 P0 — Cross-source enrichment identity-safe 纯函数测试。
 *
 * 覆盖 BLOCKER 1 的 5 类正确性场景：
 *   - 缺 company identity → skip / fail closed
 *   - A 公司 vs B 公司 → 拒绝（不 fetch / 不 upgrade）
 *   - company + role 均一致 → 允许
 *   - 相同 company 但不同 role → 拒绝
 *   - role 相同但 company 不同 → 拒绝
 */
import { describe, expect, it } from 'vitest';
import {
  buildCrossSourceQueries,
  extractCrossSourceIdentity,
  filterCrossSourceCandidates,
  isRecruitmentSource,
} from './crossSourceEnrichment';
import type { SearchEvidenceItem } from '../search-provider/types';

function makeItem(overrides: Partial<SearchEvidenceItem> = {}): SearchEvidenceItem {
  return {
    provider: 'tavily',
    query: 'q',
    title: '高级前端工程师',
    url: 'https://acme.com/careers/1',
    content: 'snippet',
    domain: 'acme.com',
    company: '字节跳动',
    searchedAt: 1,
    evidenceLevel: 'SEARCH_EVIDENCE',
    ...overrides,
  };
}

describe('isRecruitmentSource', () => {
  it('zhipin.com → true', () => {
    expect(isRecruitmentSource('zhipin.com')).toBe(true);
  });
  it('www.liepin.com → true', () => {
    expect(isRecruitmentSource('www.liepin.com')).toBe(true);
  });
  it('jobs.zhiye.com → false', () => {
    expect(isRecruitmentSource('jobs.zhiye.com')).toBe(false);
  });
  it('unknown public → false', () => {
    expect(isRecruitmentSource('acme.com')).toBe(false);
  });
  it('empty → false', () => {
    expect(isRecruitmentSource('')).toBe(false);
  });
});

describe('extractCrossSourceIdentity', () => {
  it('结构化 company + title → identity', () => {
    const id = extractCrossSourceIdentity(makeItem({ company: '字节跳动', title: '高级前端工程师' }));
    expect(id).toEqual({ company: '字节跳动', role: '高级前端工程师' });
  });

  it('缺 company → null（fail closed）', () => {
    expect(extractCrossSourceIdentity(makeItem({ company: null }))).toBeNull();
    expect(extractCrossSourceIdentity(makeItem({ company: undefined }))).toBeNull();
    expect(extractCrossSourceIdentity(makeItem({ company: '  ' }))).toBeNull();
  });

  it('缺 title → null（fail closed）', () => {
    expect(extractCrossSourceIdentity(makeItem({ title: '' }))).toBeNull();
  });
});

describe('buildCrossSourceQueries', () => {
  it('company + role → 「<company> <role>」', () => {
    const queries = buildCrossSourceQueries(makeItem({ company: '字节跳动', title: '高级前端工程师' }));
    expect(queries).toHaveLength(1);
    expect(queries[0].query).toBe('字节跳动 高级前端工程师');
  });

  it('缺 company → 空数组（禁止 role-only fallback）', () => {
    expect(buildCrossSourceQueries(makeItem({ company: null }))).toEqual([]);
  });

  it('缺 title → 空数组', () => {
    expect(buildCrossSourceQueries(makeItem({ title: '' }))).toEqual([]);
  });
});

describe('filterCrossSourceCandidates（identity-safe）', () => {
  const identity = { company: '字节跳动', role: '高级前端工程师' };

  it('company + role 均一致 → 保留', () => {
    const candidate = makeItem({
      company: undefined,
      title: '字节跳动 高级前端工程师',
      url: 'https://jobs.bytedance.com/1',
      domain: 'bytedance.com',
    });
    const result = filterCrossSourceCandidates([candidate], identity, new Set());
    expect(result.map((i) => i.url)).toEqual(['https://jobs.bytedance.com/1']);
  });

  it('A 公司 → 返回 B 公司 → 拒绝（company 不同）', () => {
    const candidate = makeItem({
      company: undefined,
      title: '腾讯 高级前端工程师',
      url: 'https://tencent.com/careers/1',
      domain: 'tencent.com',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('相同 company 但不同 role → 拒绝', () => {
    const candidate = makeItem({
      company: undefined,
      title: '字节跳动 后端工程师',
      url: 'https://jobs.bytedance.com/2',
      domain: 'bytedance.com',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('role 相同但 company 不同 → 拒绝', () => {
    const candidate = makeItem({
      company: undefined,
      title: '高级前端工程师',
      url: 'https://other-company.com/jobs/1',
      domain: 'other-company.com',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('结构化 candidate.company 不同 → 拒绝', () => {
    const candidate = makeItem({
      company: '腾讯',
      title: '高级前端工程师',
      url: 'https://tencent.com/jobs/1',
      domain: 'tencent.com',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('招聘平台 alternative → 拒绝（即便 title 命中）', () => {
    const candidate = makeItem({
      company: undefined,
      title: '字节跳动 高级前端工程师',
      url: 'https://www.zhipin.com/job/1',
      domain: 'zhipin.com',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('CONDITIONAL_FETCH（juejin）→ 拒绝', () => {
    const candidate = makeItem({
      company: undefined,
      title: '字节跳动 高级前端工程师',
      url: 'https://juejin.cn/post/1',
      domain: 'juejin.cn',
    });
    expect(filterCrossSourceCandidates([candidate], identity, new Set())).toEqual([]);
  });

  it('seenUrls / 本地重复 → 拒绝', () => {
    const a = makeItem({
      company: undefined,
      title: '字节跳动 高级前端工程师',
      url: 'https://jobs.bytedance.com/1',
      domain: 'bytedance.com',
    });
    const dup = makeItem({
      company: undefined,
      title: '字节跳动 高级前端工程师',
      url: 'https://jobs.bytedance.com/1',
      domain: 'bytedance.com',
    });
    const result = filterCrossSourceCandidates([a, dup], identity, new Set(['https://jobs.bytedance.com/1']));
    expect(result).toEqual([]);
  });
});
