/**
 * v0.9 Phase 4B — Discovery Ingestion Bridge 测试。
 *
 * 覆盖：
 *   - SEARCH_ONLY 招聘平台 → MANUAL_REVIEW_REQUIRED
 *   - SEARCH_AND_FETCH → SEARCH_EVIDENCE + fetchEligible=true
 *   - CONDITIONAL_FETCH → SEARCH_EVIDENCE + fetchEligible=false
 *   - UNKNOWN domain → MANUAL_REVIEW_REQUIRED（保守默认）
 *   - 空 domain → MANUAL_REVIEW_REQUIRED
 *   - Provider item evidenceLevel 被完全忽略（即使带 FULL_EVIDENCE）
 *   - domain 缺失时从 URL 提取
 *   - domain 和 URL 都无法解析 → UNKNOWN 保守路径
 *   - 混合多 domain SearchProviderResult
 *   - 空 SearchProviderResult
 *   - 单个 item 失败不阻断整批（skipped + errorReason）
 *   - Summary 统计正确
 *   - async 返回 Promise<DiscoveryIngestionResult>
 *   - 不调用 AnalysisService / 不创建 RecommendationBatch
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ingestDiscoveryResults } from './DiscoveryIngestionBridge';
import { SearchEvidenceIngestionService } from './SearchEvidenceIngestionService';
import type { SearchProviderResult, SearchEvidenceItem as ProviderSearchEvidenceItem } from '../../search-provider/types';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureRepository } from '../captureRepository';
import { RadarSourceRecordRepository } from '../sourceRecordRepository';
import {
  DAILY_JOB_HUNTER_SCHEMA_VERSION,
  runMigrations,
} from '../../migrations';
import { openDb } from '../../db';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProviderItem(overrides: Partial<ProviderSearchEvidenceItem> = {}): ProviderSearchEvidenceItem {
  return {
    provider: 'tavily',
    query: '苏州 前端工程师 招聘',
    providerRequestId: `req-${randomUUID().slice(0, 8)}`,
    title: '高级前端开发工程师',
    url: `https://www.zhipin.com/job_detail/test-${randomUUID().slice(0, 8)}.html`,
    content: '负责Web前端开发，使用React、TypeScript。要求3年以上经验。',
    domain: 'zhipin.com',
    providerScore: 0.85,
    publishedAt: '2026-08-01',
    searchedAt: Date.now(),
    evidenceLevel: 'SEARCH_EVIDENCE',
    providerMetadata: { response_time: 0.45 },
    ...overrides,
  };
}

function makeProviderResult(items: ProviderSearchEvidenceItem[]): SearchProviderResult {
  return {
    items,
    coverage: {
      queriesCompleted: 1,
      queriesFailed: 0,
      failedScopes: [],
      queryResults: items.length > 0
        ? [{ queryKey: 'test::query', status: 'COMPLETED', resultsReturned: items.length }]
        : [],
    },
    providerMeta: {
      requestsMade: 1,
      creditsUsed: 1,
    },
  };
}

function createService(db: Database.Database): SearchEvidenceIngestionService {
  return new SearchEvidenceIngestionService(db, {
    now: () => Date.now(),
    createId: randomUUID,
  });
}

// ── SEARCH_ONLY — 招聘平台 ────────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — SEARCH_ONLY (recruitment platforms)', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('zhipin.com → MANUAL_REVIEW_REQUIRED + fetchEligible=false', async () => {
    const providerItem = makeProviderItem({ domain: 'zhipin.com', url: 'https://www.zhipin.com/job/123' });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items).toHaveLength(1);
    const outcome = bridgeResult.items[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.sourcePolicyDecision.policy).toBe('SEARCH_ONLY');
    expect(outcome.appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.fetchEligible).toBe(false);
    expect(outcome.targetEvidenceLevelAfterFetch).toBeNull();
    expect(outcome.analysisEligible).toBe(false);
    expect(outcome.candidateId).toBeTruthy();
    expect(outcome.candidateVersionId).toBeTruthy();

    // 验证 CandidateVersion 的 evidenceLevel
    const repo = new RadarCandidateRepository(db);
    const version = repo.getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');

    // Summary
    expect(bridgeResult.summary.total).toBe(1);
    expect(bridgeResult.summary.ingested).toBe(1);
    expect(bridgeResult.summary.skipped).toBe(0);
    expect(bridgeResult.summary.byEvidenceLevel['MANUAL_REVIEW_REQUIRED']).toBe(1);
    expect(bridgeResult.summary.bySourcePolicy['SEARCH_ONLY']).toBe(1);
    expect(bridgeResult.summary.fetchEligibleCount).toBe(0);
  });

  const recruitmentPlatforms = [
    { domain: 'liepin.com', url: 'https://www.liepin.com/job/1' },
    { domain: 'zhaopin.com', url: 'https://www.zhaopin.com/job/2' },
    { domain: 'lagou.com', url: 'https://www.lagou.com/job/3' },
    { domain: '51job.com', url: 'https://www.51job.com/job/4' },
  ];

  for (const { domain, url } of recruitmentPlatforms) {
    it(`${domain} → MANUAL_REVIEW_REQUIRED`, async () => {
      const providerItem = makeProviderItem({ domain, url });
      const result = makeProviderResult([providerItem]);

      const bridgeResult = await ingestDiscoveryResults(result, service);

      expect(bridgeResult.items[0].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
      expect(bridgeResult.items[0].fetchEligible).toBe(false);
      expect(bridgeResult.items[0].sourcePolicyDecision.reason).toBe('known_recruitment_platform_manual_review_required');
    });
  }
});

// ── SEARCH_AND_FETCH ──────────────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — SEARCH_AND_FETCH', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('jobs.zhiye.com → SEARCH_EVIDENCE + fetchEligible=true + target=FULL_EVIDENCE', async () => {
    const providerItem = makeProviderItem({
      domain: 'jobs.zhiye.com',
      url: 'https://jobs.zhiye.com/careers/position/123',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.sourcePolicyDecision.policy).toBe('SEARCH_AND_FETCH');
    expect(outcome.appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.fetchEligible).toBe(true);
    expect(outcome.targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');
    expect(outcome.analysisEligible).toBe(false); // SEARCH_EVIDENCE gate

    // CandidateVersion 的 evidenceLevel = SEARCH_EVIDENCE
    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('SEARCH_EVIDENCE');

    expect(bridgeResult.summary.byEvidenceLevel['SEARCH_EVIDENCE']).toBe(1);
    expect(bridgeResult.summary.bySourcePolicy['SEARCH_AND_FETCH']).toBe(1);
    expect(bridgeResult.summary.fetchEligibleCount).toBe(1);
  });

  it('github.com → SEARCH_EVIDENCE + fetchEligible=true', async () => {
    const providerItem = makeProviderItem({
      domain: 'github.com',
      url: 'https://github.com/company/careers',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.fetchEligible).toBe(true);
    expect(outcome.targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');
    expect(outcome.sourcePolicyDecision.reason).toBe('search_and_fetch_allowed_upgrade_to_full_evidence');
  });

  it('gist.github.com → SEARCH_AND_FETCH', async () => {
    const providerItem = makeProviderItem({
      domain: 'gist.github.com',
      url: 'https://gist.github.com/abc123',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items[0].sourcePolicyDecision.policy).toBe('SEARCH_AND_FETCH');
    expect(bridgeResult.items[0].appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
  });
});

// ── CONDITIONAL_FETCH ─────────────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — CONDITIONAL_FETCH', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('juejin.cn → SEARCH_EVIDENCE + fetchEligible=false + target=null', async () => {
    const providerItem = makeProviderItem({
      domain: 'juejin.cn',
      url: 'https://juejin.cn/post/123456',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.sourcePolicyDecision.policy).toBe('CONDITIONAL_FETCH');
    expect(outcome.appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.fetchEligible).toBe(false);
    expect(outcome.targetEvidenceLevelAfterFetch).toBeNull();
    expect(outcome.sourcePolicyDecision.reason).toBe('conditional_fetch_default_no_fetch');
    expect(outcome.analysisEligible).toBe(false); // SEARCH_EVIDENCE gate

    expect(bridgeResult.summary.fetchEligibleCount).toBe(0);
  });
});

// ── UNKNOWN domain ────────────────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — UNKNOWN domain (保守默认)', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('unknown domain → MANUAL_REVIEW_REQUIRED + reason=unknown_domain_conservative', async () => {
    const providerItem = makeProviderItem({
      domain: 'totally-random-startup.io',
      url: 'https://totally-random-startup.io/careers',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.sourcePolicyDecision.policy).toBe('SEARCH_ONLY');
    expect(outcome.appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.fetchEligible).toBe(false);
    expect(outcome.sourcePolicyDecision.reason).toBe('unknown_domain_conservative_manual_review_required');
    expect(outcome.normalizedDomain).toBe('totally-random-startup.io');

    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('empty domain with valid URL → extracts domain from URL (not empty)', async () => {
    // domain="" + valid URL → resolveDomain extracts from URL
    const providerItem = makeProviderItem({
      domain: '',
      url: 'https://some-site.example/page',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.skipped).toBe(false);
    // Domain is extracted from URL — correct behavior
    expect(outcome.normalizedDomain).toBe('some-site.example');
    expect(outcome.appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.sourcePolicyDecision.reason).toBe('unknown_domain_conservative_manual_review_required');
  });
});

// ── Domain resolution — from URL when domain missing ──────────────────────────

describe('Discovery Ingestion Bridge — domain resolution from URL', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('extracts domain from URL when item.domain is empty', async () => {
    const providerItem = makeProviderItem({
      domain: '',
      url: 'https://jobs.zhiye.com/careers/position/456',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.normalizedDomain).toBe('jobs.zhiye.com');
    expect(outcome.sourcePolicyDecision.policy).toBe('SEARCH_AND_FETCH');
    expect(outcome.appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.fetchEligible).toBe(true);
  });

  it('extracts domain from URL when item.domain is missing', async () => {
    const providerItem = makeProviderItem({
      domain: undefined as unknown as string,
      url: 'https://www.zhipin.com/job_detail/789',
    });
    // Reconstruct with explicit undefined domain
    const item: ProviderSearchEvidenceItem = {
      ...makeProviderItem(),
      domain: undefined as unknown as string,
      url: 'https://www.zhipin.com/job_detail/789',
    };
    const result = makeProviderResult([item]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items[0].normalizedDomain).toBe('www.zhipin.com');
    expect(bridgeResult.items[0].sourcePolicyDecision.policy).toBe('SEARCH_ONLY');
    expect(bridgeResult.items[0].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('unresolvable domain AND url → MANUAL_REVIEW_REQUIRED (conservative)', async () => {
    const providerItem = makeProviderItem({
      domain: '',
      url: '',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    // Should still ingest — UNKNOWN conservative path
    expect(outcome.skipped).toBe(false);
    expect(outcome.normalizedDomain).toBe('');
    expect(outcome.appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.sourcePolicyDecision.reason).toBe('unknown_domain_conservative_manual_review_required');

    // CandidateVersion should still be created
    expect(outcome.candidateId).toBeTruthy();
    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
  });
});

// ── Provider evidenceLevel ignored ────────────────────────────────────────────

describe('Discovery Ingestion Bridge — provider evidenceLevel ignored', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('provider item with evidenceLevel=FULL_EVIDENCE still ingested as SEARCH_EVIDENCE (zhiye.com)', async () => {
    // Provider 恶意/错误地标记为 FULL_EVIDENCE——Bridge 必须忽略。
    const providerItem = makeProviderItem({
      domain: 'jobs.zhiye.com',
      url: 'https://jobs.zhiye.com/careers/123',
      evidenceLevel: 'FULL_EVIDENCE' as const,
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    // appliedEvidenceLevel 来自 SourcePolicyDecision，不是 provider item
    expect(outcome.appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.appliedEvidenceLevel).not.toBe('FULL_EVIDENCE');

    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(version!.evidenceLevel).not.toBe('FULL_EVIDENCE');
  });

  it('provider item with evidenceLevel=FULL_EVIDENCE on recruitment platform → MANUAL_REVIEW_REQUIRED', async () => {
    const providerItem = makeProviderItem({
      domain: 'zhipin.com',
      url: 'https://www.zhipin.com/job/999',
      evidenceLevel: 'FULL_EVIDENCE' as const,
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const outcome = bridgeResult.items[0];
    expect(outcome.appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
    expect(outcome.appliedEvidenceLevel).not.toBe('FULL_EVIDENCE');

    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('NO item calls ingest with FULL_EVIDENCE (invariant)', async () => {
    // 构造混合结果：包含招聘平台、SEARCH_AND_FETCH、unknown
    const items: ProviderSearchEvidenceItem[] = [
      makeProviderItem({ domain: 'zhipin.com', url: 'https://www.zhipin.com/job/1', evidenceLevel: 'FULL_EVIDENCE' as const }),
      makeProviderItem({ domain: 'jobs.zhiye.com', url: 'https://jobs.zhiye.com/job/2', evidenceLevel: 'FULL_EVIDENCE' as const }),
      makeProviderItem({ domain: 'github.com', url: 'https://github.com/job/3', evidenceLevel: 'SEARCH_EVIDENCE' }),
      makeProviderItem({ domain: 'juejin.cn', url: 'https://juejin.cn/job/4', evidenceLevel: 'SEARCH_EVIDENCE' }),
      makeProviderItem({ domain: 'unknown.example', url: 'https://unknown.example/job/5', evidenceLevel: 'FULL_EVIDENCE' as const }),
    ];
    const result = makeProviderResult(items);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    // 验证每个 outcome 的 appliedEvidenceLevel 都不是 FULL_EVIDENCE
    for (const outcome of bridgeResult.items) {
      expect(outcome.appliedEvidenceLevel).not.toBe('FULL_EVIDENCE');
    }

    // 验证数据库中的 CandidateVersion 也没有 FULL_EVIDENCE（来自这批 bridge）
    const repo = new RadarCandidateRepository(db);
    for (const outcome of bridgeResult.items) {
      if (outcome.candidateVersionId) {
        const version = repo.getVersion(outcome.candidateVersionId);
        expect(version!.evidenceLevel).not.toBe('FULL_EVIDENCE');
      }
    }

    // Summary 中也不应有 FULL_EVIDENCE
    expect(bridgeResult.summary.byEvidenceLevel['FULL_EVIDENCE']).toBeUndefined();
  });
});

// ── Mixed SearchProviderResult ────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — mixed results', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('each item independently resolved by domain policy', async () => {
    const items: ProviderSearchEvidenceItem[] = [
      makeProviderItem({ domain: 'zhipin.com', url: 'https://www.zhipin.com/job/1' }),
      makeProviderItem({ domain: 'liepin.com', url: 'https://www.liepin.com/job/2' }),
      makeProviderItem({ domain: 'jobs.zhiye.com', url: 'https://jobs.zhiye.com/job/3' }),
      makeProviderItem({ domain: 'github.com', url: 'https://github.com/job/4' }),
      makeProviderItem({ domain: 'juejin.cn', url: 'https://juejin.cn/job/5' }),
      makeProviderItem({ domain: 'random-blog.cn', url: 'https://random-blog.cn/job/6' }),
      makeProviderItem({ domain: '', url: '' }),
    ];
    const result = makeProviderResult(items);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items).toHaveLength(7);
    expect(bridgeResult.summary.total).toBe(7);
    expect(bridgeResult.summary.ingested).toBe(7);
    expect(bridgeResult.summary.skipped).toBe(0);

    // Expected evidence levels per domain
    expect(bridgeResult.items[0].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED'); // zhipin
    expect(bridgeResult.items[1].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED'); // liepin
    expect(bridgeResult.items[2].appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');        // zhiye
    expect(bridgeResult.items[3].appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');        // github
    expect(bridgeResult.items[4].appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');        // juejin
    expect(bridgeResult.items[5].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED'); // unknown
    expect(bridgeResult.items[6].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED'); // empty

    // Summary breakdown
    expect(bridgeResult.summary.byEvidenceLevel['MANUAL_REVIEW_REQUIRED']).toBe(4);
    expect(bridgeResult.summary.byEvidenceLevel['SEARCH_EVIDENCE']).toBe(3);
    expect(bridgeResult.summary.bySourcePolicy['SEARCH_ONLY']).toBe(4); // zhipin+liepin+unknown+empty
    expect(bridgeResult.summary.bySourcePolicy['SEARCH_AND_FETCH']).toBe(2); // zhiye+github
    expect(bridgeResult.summary.bySourcePolicy['CONDITIONAL_FETCH']).toBe(1); // juejin
    expect(bridgeResult.summary.fetchEligibleCount).toBe(2); // zhiye+github
  });
});

// ── Empty SearchProviderResult ─────────────────────────────────────────────────

describe('Discovery Ingestion Bridge — empty result', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('empty items → summary all zeros, no crash', async () => {
    const result = makeProviderResult([]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items).toHaveLength(0);
    expect(bridgeResult.summary.total).toBe(0);
    expect(bridgeResult.summary.ingested).toBe(0);
    expect(bridgeResult.summary.skipped).toBe(0);
    expect(bridgeResult.summary.fetchEligibleCount).toBe(0);
    expect(Object.keys(bridgeResult.summary.byEvidenceLevel)).toHaveLength(0);
    expect(Object.keys(bridgeResult.summary.bySourcePolicy)).toHaveLength(0);
  });
});

// ── Single item failure does not block batch ──────────────────────────────────

describe('Discovery Ingestion Bridge — error isolation', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('single item ingest failure → skipped=true + errorReason, other items succeed', async () => {
    const goodItem1 = makeProviderItem({ domain: 'zhipin.com', url: 'https://www.zhipin.com/job/good1' });
    const goodItem2 = makeProviderItem({ domain: 'jobs.zhiye.com', url: 'https://jobs.zhiye.com/job/good2' });
    const toxicItem: ProviderSearchEvidenceItem = {
      provider: 'tavily',
      query: 'test',
      title: 'toxic',
      url: 'https://valid-url.example/job/toxic',
      content: 'toxic',
      domain: 'valid-domain.example',
      searchedAt: Date.now(),
      evidenceLevel: 'SEARCH_EVIDENCE',
    };

    const result = makeProviderResult([goodItem1, toxicItem, goodItem2]);

    // Spy: call #2 (toxicItem) 抛出异常，其他调用走真实实现
    const originalIngest = service.ingest.bind(service);
    let callCount = 0;
    const ingestSpy = vi.spyOn(service, 'ingest').mockImplementation((item, level) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Simulated DB constraint violation');
      }
      return originalIngest(item, level);
    });

    const bridgeResult = await ingestDiscoveryResults(result, service);

    expect(bridgeResult.items).toHaveLength(3);

    // Good item 1 — 成功
    expect(bridgeResult.items[0].skipped).toBe(false);
    expect(bridgeResult.items[0].candidateId).toBeTruthy();
    expect(bridgeResult.items[0].appliedEvidenceLevel).toBe('MANUAL_REVIEW_REQUIRED');

    // Toxic item — skipped
    expect(bridgeResult.items[1].skipped).toBe(true);
    expect(bridgeResult.items[1].errorReason).toBe('Simulated DB constraint violation');
    expect(bridgeResult.items[1].candidateId).toBeNull();
    expect(bridgeResult.items[1].snapshotId).toBeNull();
    // SourcePolicyDecision 仍然被计算（用于 reporting）
    expect(bridgeResult.items[1].sourcePolicyDecision.policy).toBe('SEARCH_ONLY');
    expect(bridgeResult.items[1].fetchEligible).toBe(false);

    // Good item 2 — 仍然成功（不受 toxic 影响）
    expect(bridgeResult.items[2].skipped).toBe(false);
    expect(bridgeResult.items[2].candidateId).toBeTruthy();
    expect(bridgeResult.items[2].appliedEvidenceLevel).toBe('SEARCH_EVIDENCE');

    // Summary
    expect(bridgeResult.summary.total).toBe(3);
    expect(bridgeResult.summary.ingested).toBe(2);
    expect(bridgeResult.summary.skipped).toBe(1);

    ingestSpy.mockRestore();
  });
});

// ── Boundary: no AnalysisService / no RecommendationBatch ─────────────────────

describe('Discovery Ingestion Bridge — boundary constraints', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('does not create RecommendationBatch rows', async () => {
    const providerItem = makeProviderItem({ domain: 'jobs.zhiye.com', url: 'https://jobs.zhiye.com/job/1' });
    const result = makeProviderResult([providerItem]);

    await ingestDiscoveryResults(result, service);

    const batchCount = (db.prepare('SELECT COUNT(*) AS cnt FROM radar_recommendation_batches').get() as { cnt: number }).cnt;
    expect(batchCount).toBe(0);
  });

  it('does not create MatchAnalysis rows', async () => {
    const providerItem = makeProviderItem({ domain: 'zhipin.com', url: 'https://www.zhipin.com/job/1' });
    const result = makeProviderResult([providerItem]);

    await ingestDiscoveryResults(result, service);

    const analysisCount = (db.prepare('SELECT COUNT(*) AS cnt FROM job_match_analysis_records').get() as { cnt: number }).cnt;
    expect(analysisCount).toBe(0);
  });

  it('returns Promise<DiscoveryIngestionResult>', async () => {
    const providerItem = makeProviderItem();
    const result = makeProviderResult([providerItem]);

    const promise = ingestDiscoveryResults(result, service);
    expect(promise).toBeInstanceOf(Promise);

    const bridgeResult = await promise;
    expect(bridgeResult).toHaveProperty('items');
    expect(bridgeResult).toHaveProperty('summary');
    expect(bridgeResult.summary).toHaveProperty('total');
    expect(bridgeResult.summary).toHaveProperty('ingested');
    expect(bridgeResult.summary).toHaveProperty('skipped');
    expect(bridgeResult.summary).toHaveProperty('byEvidenceLevel');
    expect(bridgeResult.summary).toHaveProperty('bySourcePolicy');
    expect(bridgeResult.summary).toHaveProperty('fetchEligibleCount');
  });
});

// ── fetchEligible transient (not persisted) ────────────────────────────────────

describe('Discovery Ingestion Bridge — fetchEligible transient', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('fetchEligible is recorded in outcome but NOT in CandidateVersion', async () => {
    const providerItem = makeProviderItem({
      domain: 'jobs.zhiye.com',
      url: 'https://jobs.zhiye.com/job/fetch-eligible-test',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    // Outcome 中记录 fetchEligible
    expect(bridgeResult.items[0].fetchEligible).toBe(true);
    expect(bridgeResult.items[0].targetEvidenceLevelAfterFetch).toBe('FULL_EVIDENCE');

    // 但 CandidateVersion 中没有 fetchEligible 字段
    const version = new RadarCandidateRepository(db).getVersion(bridgeResult.items[0].candidateVersionId!);
    expect(version).not.toHaveProperty('fetchEligible');
    expect(version!.evidenceLevel).toBe('SEARCH_EVIDENCE');
  });

  it('rawSnapshot does not contain fetchEligible or sourcePolicy fields', async () => {
    const providerItem = makeProviderItem({
      domain: 'jobs.zhiye.com',
      url: 'https://jobs.zhiye.com/job/raw-snapshot-test',
    });
    const result = makeProviderResult([providerItem]);

    const bridgeResult = await ingestDiscoveryResults(result, service);

    const snapshot = new RadarCaptureRepository(db).getSnapshot(bridgeResult.items[0].snapshotId!);
    const raw = snapshot!.rawSnapshot as Record<string, unknown>;
    expect(raw).not.toHaveProperty('fetchEligible');
    expect(raw).not.toHaveProperty('sourcePolicy');
    expect(raw).not.toHaveProperty('sourcePolicyDecision');
  });
});

// ── Deduplication across bridge calls ──────────────────────────────────────────

describe('Discovery Ingestion Bridge — dedup across calls', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    service = createService(db);
  });

  it('same URL twice → second call deduplicates (no_change)', async () => {
    const providerItem = makeProviderItem({
      domain: 'zhipin.com',
      url: 'https://www.zhipin.com/job/same-url',
    });
    const result1 = makeProviderResult([providerItem]);
    const result2 = makeProviderResult([providerItem]);

    const first = await ingestDiscoveryResults(result1, service);
    const second = await ingestDiscoveryResults(result2, service);

    expect(first.items[0].decisionType).toBe('new_identity');
    expect(second.items[0].decisionType).toBe('no_change');
    expect(second.items[0].candidateId).toBe(first.items[0].candidateId);
    expect(second.items[0].candidateVersionId).toBe(first.items[0].candidateVersionId);

    // 只创建了一个 Candidate
    const candidates = new RadarCandidateRepository(db).listActiveCandidates();
    expect(candidates.length).toBe(1);
  });
});
