/**
 * v0.9 Phase 4C-1 — Source Eligibility 测试。
 *
 * 覆盖 T035 完成条件第 1 项 + Amendment 要求：
 *   SEARCH_AND_FETCH → eligible；SEARCH_ONLY / CONDITIONAL_FETCH / unknown → ineligible；
 *   招聘平台（zhipin/liepin/zhaopin/lagou/51job）无法通过 sourceEligibility 拿到 eligible 请求。
 */
import { describe, expect, it } from 'vitest';
import { sourceEligibility } from './sourceEligibility';

// ── SEARCH_AND_FETCH → eligible ────────────────────────────────────────────────

describe('sourceEligibility — SEARCH_AND_FETCH → eligible', () => {
  it('jobs.zhiye.com → eligible，请求 sourcePolicy 窄化为 SEARCH_AND_FETCH', () => {
    const r = sourceEligibility('https://jobs.zhiye.com/jobs/123');
    expect(r.kind).toBe('eligible');
    if (r.kind === 'eligible') {
      expect(r.request.sourcePolicy).toBe('SEARCH_AND_FETCH');
      expect(r.request.normalizedDomain).toBe('jobs.zhiye.com');
      expect(r.request.url).toBe('https://jobs.zhiye.com/jobs/123');
    }
  });

  it('github.com → eligible', () => {
    expect(sourceEligibility('https://github.com/acme/roles').kind).toBe('eligible');
  });

  it('gist.github.com → eligible', () => {
    expect(sourceEligibility('https://gist.github.com/acme/abc').kind).toBe('eligible');
  });
});

// ── 招聘平台（SEARCH_ONLY）→ ineligible ────────────────────────────────────────

describe('sourceEligibility — recruitment platforms (SEARCH_ONLY) → ineligible', () => {
  const platforms = [
    ['zhipin.com', 'https://www.zhipin.com/job_detail/1.html'],
    ['liepin.com', 'https://www.liepin.com/job/1'],
    ['zhaopin.com', 'https://www.zhaopin.com/job/1'],
    ['lagou.com', 'https://www.lagou.com/jobs/1.html'],
    ['51job.com', 'https://search.51job.com/list/1.html'],
  ] as const;

  for (const [domain, url] of platforms) {
    it(`${domain} → ineligible (BLOCKED_BY_POLICY)`, () => {
      const r = sourceEligibility(url);
      expect(r.kind).toBe('ineligible');
      if (r.kind === 'ineligible') {
        expect(r.error.code).toBe('BLOCKED_BY_POLICY');
        expect(r.error.reason).toBe('known_recruitment_platform_manual_review_required');
      }
    });
  }
});

// ── unknown domain → 保守拒绝 ──────────────────────────────────────────────────

describe('sourceEligibility — unknown domain → conservative deny', () => {
  it('random-company.xyz → ineligible + unknown_domain_conservative', () => {
    const r = sourceEligibility('https://random-company.xyz/jobs/1');
    expect(r.kind).toBe('ineligible');
    if (r.kind === 'ineligible') {
      expect(r.error.code).toBe('BLOCKED_BY_POLICY');
      expect(r.error.reason).toBe('unknown_domain_conservative_manual_review_required');
    }
  });

  it('empty input → ineligible (conservative)', () => {
    const r = sourceEligibility('');
    expect(r.kind).toBe('ineligible');
  });
});

// ── CONDITIONAL_FETCH → 默认不 eligible ────────────────────────────────────────

describe('sourceEligibility — CONDITIONAL_FETCH → not automatically eligible', () => {
  it('juejin.cn → ineligible by default', () => {
    const r = sourceEligibility('https://juejin.cn/post/1');
    expect(r.kind).toBe('ineligible');
    if (r.kind === 'ineligible') {
      expect(r.error.code).toBe('BLOCKED_BY_POLICY');
      expect(r.error.reason).toBe('conditional_fetch_default_no_fetch');
    }
  });
});

// ── 不变量：被禁止来源永远拿不到 eligible 请求 ─────────────────────────────────

describe('sourceEligibility — forbidden sources never yield an eligible request', () => {
  it('招聘平台 / conditional / unknown 全部返回 ineligible', () => {
    const urls = [
      'https://www.zhipin.com/job_detail/1.html',
      'https://www.liepin.com/job/1',
      'https://www.zhaopin.com/job/1',
      'https://www.lagou.com/jobs/1.html',
      'https://search.51job.com/list/1.html',
      'https://juejin.cn/post/1',
      'https://random-unknown.io/x',
    ];
    for (const url of urls) {
      expect(sourceEligibility(url).kind).toBe('ineligible');
    }
  });
});
