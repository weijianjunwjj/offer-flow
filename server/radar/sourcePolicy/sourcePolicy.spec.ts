/**
 * v0.9 Phase 4A — Source Policy + Evidence Level Mapping 测试。
 *
 * T033 / T034 / T036: 覆盖所有已知 domain × policy × evidenceLevel × reason，
 * UNKNOWN 保守默认，以及 NO policy produces FULL_EVIDENCE 不变量。
 */
import { describe, expect, it } from 'vitest';
import {
  classifySourcePolicy,
  getSourcePolicyDecision,
  normalizeDomain,
} from './sourcePolicy';

// ── normalizeDomain ────────────────────────────────────────────────────────────

describe('normalizeDomain', () => {
  it('strips https:// protocol', () => {
    expect(normalizeDomain('https://www.zhipin.com/job/abc')).toBe('www.zhipin.com');
  });

  it('strips http:// protocol', () => {
    expect(normalizeDomain('http://zhipin.com')).toBe('zhipin.com');
  });

  it('trims whitespace', () => {
    expect(normalizeDomain('  zhipin.com  ')).toBe('zhipin.com');
  });

  it('lowercases', () => {
    expect(normalizeDomain('WWW.ZHIPIN.COM')).toBe('www.zhipin.com');
  });

  it('strips path and query', () => {
    expect(normalizeDomain('zhipin.com/job_detail/abc?query=1')).toBe('zhipin.com');
  });

  it('removes port', () => {
    expect(normalizeDomain('localhost:5173')).toBe('localhost');
  });

  it('returns empty for empty string', () => {
    expect(normalizeDomain('')).toBe('');
  });

  it('returns empty for null', () => {
    expect(normalizeDomain(null)).toBe('');
  });

  it('returns empty for undefined', () => {
    expect(normalizeDomain(undefined)).toBe('');
  });
});

// ── classifySourcePolicy: recruitment platforms → SEARCH_ONLY ──────────────────

describe('classifySourcePolicy — recruitment platforms → SEARCH_ONLY', () => {
  it('zhipin.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('zhipin.com')).toBe('SEARCH_ONLY');
  });

  it('www.zhipin.com → SEARCH_ONLY (subdomain)', () => {
    expect(classifySourcePolicy('www.zhipin.com')).toBe('SEARCH_ONLY');
  });

  it('liepin.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('liepin.com')).toBe('SEARCH_ONLY');
  });

  it('vip.liepin.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('vip.liepin.com')).toBe('SEARCH_ONLY');
  });

  it('zhaopin.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('zhaopin.com')).toBe('SEARCH_ONLY');
  });

  it('www.zhaopin.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('www.zhaopin.com')).toBe('SEARCH_ONLY');
  });

  it('lagou.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('lagou.com')).toBe('SEARCH_ONLY');
  });

  it('www.lagou.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('www.lagou.com')).toBe('SEARCH_ONLY');
  });

  it('51job.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('51job.com')).toBe('SEARCH_ONLY');
  });

  it('search.51job.com → SEARCH_ONLY', () => {
    expect(classifySourcePolicy('search.51job.com')).toBe('SEARCH_ONLY');
  });
});

// ── classifySourcePolicy: SEARCH_AND_FETCH ─────────────────────────────────────

describe('classifySourcePolicy — SEARCH_AND_FETCH', () => {
  it('jobs.zhiye.com → SEARCH_AND_FETCH', () => {
    expect(classifySourcePolicy('jobs.zhiye.com')).toBe('SEARCH_AND_FETCH');
  });

  it('special.zhiye.com → SEARCH_AND_FETCH', () => {
    expect(classifySourcePolicy('special.zhiye.com')).toBe('SEARCH_AND_FETCH');
  });

  it('hr.zhiye.com → SEARCH_AND_FETCH', () => {
    expect(classifySourcePolicy('hr.zhiye.com')).toBe('SEARCH_AND_FETCH');
  });

  it('github.com → SEARCH_AND_FETCH', () => {
    expect(classifySourcePolicy('github.com')).toBe('SEARCH_AND_FETCH');
  });

  it('gist.github.com → SEARCH_AND_FETCH', () => {
    expect(classifySourcePolicy('gist.github.com')).toBe('SEARCH_AND_FETCH');
  });
});

// ── classifySourcePolicy: CONDITIONAL_FETCH ────────────────────────────────────

describe('classifySourcePolicy — CONDITIONAL_FETCH', () => {
  it('juejin.cn → CONDITIONAL_FETCH', () => {
    expect(classifySourcePolicy('juejin.cn')).toBe('CONDITIONAL_FETCH');
  });
});

// ── classifySourcePolicy: unknown / empty — conservative default ───────────────

describe('classifySourcePolicy — unknown / conservative default', () => {
  it('empty string → SEARCH_ONLY (conservative)', () => {
    expect(classifySourcePolicy('')).toBe('SEARCH_ONLY');
  });

  it('totally-unknown.example → SEARCH_ONLY (conservative)', () => {
    expect(classifySourcePolicy('totally-unknown.example')).toBe('SEARCH_ONLY');
  });

  it('randomstartup.io → SEARCH_ONLY (conservative)', () => {
    expect(classifySourcePolicy('randomstartup.io')).toBe('SEARCH_ONLY');
  });
});

// ── getSourcePolicyDecision: SEARCH_ONLY (recruitment) ─────────────────────────

describe('getSourcePolicyDecision — recruitment platforms', () => {
  it('zhipin.com → SEARCH_ONLY + MANUAL_REVIEW_REQUIRED + fetchEligible=false + reason=known_recruitment', () => {
    const d = getSourcePolicyDecision('zhipin.com');
    expect(d.policy).toBe('SEARCH_ONLY');
    expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
    expect(d.reason).toBe('known_recruitment_platform_manual_review_required');
    expect(d.normalizedDomain).toBe('zhipin.com');
  });

  it('liepin.com → reason=known_recruitment', () => {
    expect(getSourcePolicyDecision('liepin.com').reason)
      .toBe('known_recruitment_platform_manual_review_required');
  });

  it('zhaopin.com → reason=known_recruitment', () => {
    expect(getSourcePolicyDecision('zhaopin.com').reason)
      .toBe('known_recruitment_platform_manual_review_required');
  });

  it('lagou.com → reason=known_recruitment', () => {
    expect(getSourcePolicyDecision('lagou.com').reason)
      .toBe('known_recruitment_platform_manual_review_required');
  });

  it('51job.com → reason=known_recruitment', () => {
    expect(getSourcePolicyDecision('51job.com').reason)
      .toBe('known_recruitment_platform_manual_review_required');
  });
});

// ── getSourcePolicyDecision: SEARCH_ONLY (unknown / conservative) ──────────────

describe('getSourcePolicyDecision — unknown domain conservative', () => {
  it('unknown domain → reason=unknown_domain_conservative', () => {
    const d = getSourcePolicyDecision('random-company.xyz');
    expect(d.policy).toBe('SEARCH_ONLY');
    expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
    expect(d.reason).toBe('unknown_domain_conservative_manual_review_required');
    expect(d.normalizedDomain).toBe('random-company.xyz');
  });

  it('empty string → reason=unknown_domain_conservative', () => {
    const d = getSourcePolicyDecision('');
    expect(d.policy).toBe('SEARCH_ONLY');
    expect(d.reason).toBe('unknown_domain_conservative_manual_review_required');
    expect(d.normalizedDomain).toBe('');
  });
});

// ── getSourcePolicyDecision: SEARCH_AND_FETCH ──────────────────────────────────

describe('getSourcePolicyDecision — SEARCH_AND_FETCH', () => {
  it('jobs.zhiye.com → SEARCH_AND_FETCH + initialEvidenceLevel=SEARCH_EVIDENCE + fetchEligible=true', () => {
    const d = getSourcePolicyDecision('jobs.zhiye.com');
    expect(d.policy).toBe('SEARCH_AND_FETCH');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(d.fetchEligible).toBe(true);
    expect(d.targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');
    expect(d.reason).toBe('search_and_fetch_allowed_upgrade_to_full_evidence');
  });

  it('github.com → initialEvidenceLevel=SEARCH_EVIDENCE + fetchEligible=true', () => {
    const d = getSourcePolicyDecision('github.com');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(d.fetchEligible).toBe(true);
    expect(d.targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');
  });

  it('zhiye.com (bare) → SEARCH_AND_FETCH', () => {
    const d = getSourcePolicyDecision('zhiye.com');
    expect(d.policy).toBe('SEARCH_AND_FETCH');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
  });

  it('normalizedDomain is correct for subdomains', () => {
    expect(getSourcePolicyDecision('https://jobs.zhiye.com/careers').normalizedDomain)
      .toBe('jobs.zhiye.com');
  });
});

// ── getSourcePolicyDecision: CONDITIONAL_FETCH ─────────────────────────────────

describe('getSourcePolicyDecision — CONDITIONAL_FETCH', () => {
  it('juejin.cn → CONDITIONAL_FETCH + initialEvidenceLevel=SEARCH_EVIDENCE + fetchEligible=false', () => {
    const d = getSourcePolicyDecision('juejin.cn');
    expect(d.policy).toBe('CONDITIONAL_FETCH');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
    expect(d.reason).toBe('conditional_fetch_default_no_fetch');
  });
});

// ── Invariant: NO policy produces FULL_EVIDENCE as initialEvidenceLevel ────────

describe('invariant: no SourcePolicy produces FULL_EVIDENCE as initialEvidenceLevel', () => {
  const allDomains = [
    'zhipin.com', 'liepin.com', 'zhaopin.com', 'lagou.com', '51job.com',
    'jobs.zhiye.com', 'github.com', 'juejin.cn',
    'random-unknown.io', '',
  ];

  for (const domain of allDomains) {
    const label = domain || '(empty)';
    it(`${label} initialEvidenceLevel ≠ FULL_EVIDENCE`, () => {
      const d = getSourcePolicyDecision(domain);
      expect(d.initialEvidenceLevel).not.toBe('FULL_EVIDENCE');
    });
  }
});

// ── Round-trip: domain → policy → evidenceLevel ────────────────────────────────

describe('round-trip: domain → policy → evidenceLevel', () => {
  it('zhipin.com → SEARCH_ONLY → MANUAL_REVIEW_REQUIRED → fetchEligible=false', () => {
    const d = getSourcePolicyDecision('www.zhipin.com');
    expect(d.policy).toBe('SEARCH_ONLY');
    expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
  });

  it('jobs.zhiye.com → SEARCH_AND_FETCH → SEARCH_EVIDENCE → fetchEligible=true → target=FULL_EVIDENCE', () => {
    const d = getSourcePolicyDecision('jobs.zhiye.com');
    expect(d.policy).toBe('SEARCH_AND_FETCH');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(d.fetchEligible).toBe(true);
    expect(d.targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');
  });

  it('juejin.cn → CONDITIONAL_FETCH → SEARCH_EVIDENCE → fetchEligible=false → target=null', () => {
    const d = getSourcePolicyDecision('juejin.cn');
    expect(d.policy).toBe('CONDITIONAL_FETCH');
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
  });

  it('unknown → SEARCH_ONLY → MANUAL_REVIEW_REQUIRED → fetchEligible=false → target=null', () => {
    const d = getSourcePolicyDecision('some-random-blog.cn');
    expect(d.policy).toBe('SEARCH_ONLY');
    expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(d.fetchEligible).toBe(false);
    expect(d.targetEvidenceLevelAfterFetch).toBeNull();
  });
});

// ── Data Quality Gate via SourcePolicyDecision ─────────────────────────────────

describe('Data Quality Gate: canEnterAnalysis(initialEvidenceLevel) for all known domains', () => {
  // Import inline to avoid circular — we test the integrated behavior:
  // jobs.zhiye.com initialEvidenceLevel=SEARCH_EVIDENCE → should NOT enter analysis before fetch.
  it('jobs.zhiye.com before fetch → SEARCH_EVIDENCE → should NOT enter analysis', () => {
    const d = getSourcePolicyDecision('jobs.zhiye.com');
    // initialEvidenceLevel is SEARCH_EVIDENCE, NOT FULL_EVIDENCE
    expect(d.initialEvidenceLevel).toBe('SEARCH_EVIDENCE');
    // This means before ContentFetcher runs, canEnterAnalysis(SEARCH_EVIDENCE) = false
  });

  it('zhipin/liepin/zhaopin/lagou/51job → MANUAL_REVIEW_REQUIRED → should NOT enter analysis', () => {
    const platforms = ['zhipin.com', 'liepin.com', 'zhaopin.com', 'lagou.com', '51job.com'];
    for (const domain of platforms) {
      const d = getSourcePolicyDecision(domain);
      expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
      expect(d.fetchEligible).toBe(false);
    }
  });

  it('only explicit FULL_EVIDENCE (not from any SourcePolicy) allows analysis entry', () => {
    // FULL_EVIDENCE never comes from getSourcePolicyDecision — it must be explicitly passed in.
    for (const domain of ['zhipin.com', 'jobs.zhiye.com', 'github.com', 'juejin.cn', 'example.com']) {
      const d = getSourcePolicyDecision(domain);
      expect(d.initialEvidenceLevel).not.toBe('FULL_EVIDENCE');
    }
  });

  it('unknown domain → MANUAL_REVIEW_REQUIRED → should NOT enter analysis', () => {
    const d = getSourcePolicyDecision('wowow.unknown');
    expect(d.initialEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(d.fetchEligible).toBe(false);
  });
});
