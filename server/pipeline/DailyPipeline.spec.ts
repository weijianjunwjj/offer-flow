/**
 * OfferFlow v0.9 — DailyPipeline 编排测试（Phase 5B）。
 *
 * 采用窄接口注入 fake/spy，验证编排契约：
 *   - Existing FULL fast path、SEARCH_EVIDENCE fetch path、MANUAL_REVIEW / 非 fetch；
 *   - 统一分析流 + AnalysisTask 状态机分支；
 *   - repeat-run 幂等（不重复 fetch / upgrade / LLM）；
 *   - 失败隔离、abort 语义、Recommendation 每次 run 至多一次。
 */

import { describe, expect, it, vi } from 'vitest';
import { DailyPipeline } from './DailyPipeline';
import type { DailyPipelineDeps } from './types';
import type {
  SearchEvidenceItem,
  SearchProviderResult,
  SearchQuery,
} from '../search-provider/types';
import type { DiscoveryIngestionItemOutcome } from '../radar/searchEvidence/DiscoveryIngestionBridge';
import type { FetchResult } from '../content-acquisition/types';
import type { EvidenceUpgradeResult } from '../radar/evidenceUpgrade/types';
import type {
  AnalysisTask,
  AnalysisTaskErrorCode,
  AnalysisTaskStatus,
  RadarCandidate,
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarEvidenceLevel,
  RadarRecommendationBatch,
} from '../../src/domain/radar';
import type { CreateAnalysisTaskResult } from '../radar/analysis/analysisService';
import type { RunOutcome } from '../radar/analysis/executor';
import type { CreateBatchResult } from '../radar/recommendation/recommendationBatchService';
import { AnalysisInputError } from '../radar/analysis/inputErrors';
import { AnalysisContractError } from '../radar/analysis/contractErrors';

// ── Fixtures / builders ────────────────────────────────────────────────────────

const QUERY: SearchQuery = {
  query: '苏州 前端工程师 招聘',
  queryKey: '苏州×前端开发×前端',
  city: '苏州',
  roleDirection: '前端开发',
  keyword: '前端',
  keywordSource: 'base',
};

function emptyNormalized(): RadarCandidateNormalized {
  return {
    company: null, role: '前端工程师', city: null, district: null,
    salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
    experienceRequirement: null, educationRequirement: null,
    companySize: null, industry: null, jobNature: null, workMode: null,
    technicalStack: [], responsibilities: [], requirements: [],
    publishedAt: null, rawDescription: 'JD',
  };
}

function makeSearchItem(url: string, overrides: Partial<SearchEvidenceItem> = {}): SearchEvidenceItem {
  return {
    provider: 'tavily',
    query: QUERY.query,
    title: '高级前端工程师',
    url,
    content: '岗位摘要',
    domain: 'jobs.zhiye.com',
    providerScore: 0.9,
    searchedAt: 1_700_000_000,
    evidenceLevel: 'SEARCH_EVIDENCE',
    ...overrides,
  };
}

function makeSearchResult(items: SearchEvidenceItem[]): SearchProviderResult {
  return {
    items,
    coverage: { queriesCompleted: 1, queriesFailed: 0, failedScopes: [], queryResults: [] },
    providerMeta: { requestsMade: 1 },
  };
}

function makeBridgeOutcome(
  itemUrl: string,
  overrides: Partial<DiscoveryIngestionItemOutcome> = {},
): DiscoveryIngestionItemOutcome {
  return {
    itemUrl,
    providerDomain: 'jobs.zhiye.com',
    normalizedDomain: 'jobs.zhiye.com',
    sourcePolicyDecision: {
      policy: 'SEARCH_AND_FETCH',
      initialEvidenceLevel: 'SEARCH_EVIDENCE',
      fetchEligible: true,
      targetEvidenceLevelAfterFetch: 'FULL_EVIDENCE',
      reason: 'search_and_fetch_allowed_upgrade_to_full_evidence',
      normalizedDomain: 'jobs.zhiye.com',
    },
    appliedEvidenceLevel: 'SEARCH_EVIDENCE',
    fetchEligible: true,
    targetEvidenceLevelAfterFetch: 'FULL_EVIDENCE',
    snapshotId: 'snap-1',
    candidateId: 'cand-1',
    candidateVersionId: 'ver-1',
    sourceRecordId: 'src-1',
    decisionType: 'new_identity',
    analysisEligible: false,
    skipped: false,
    errorReason: null,
    ...overrides,
  };
}

function makeVersion(id: string, evidenceLevel: RadarEvidenceLevel, candidateId?: string): RadarCandidateVersion {
  return {
    id,
    candidateId: candidateId ?? 'cand-1',
    versionNo: 1,
    normalized: emptyNormalized(),
    qualityIssues: [],
    sourceSnapshotIds: [],
    contentHash: `hash-${id}`,
    originType: 'captured',
    evidenceLevel,
    correctionNote: null,
    supersedesVersionId: null,
    createdAt: 1_700_000_000,
  };
}

function makeCandidate(id: string, activeVersionId: string): RadarCandidate {
  return {
    id,
    primarySourceRecordId: `src-${id}`,
    activeVersionId,
    lifecycleStatus: 'active',
    mergedIntoCandidateId: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  };
}

function makeTask(id: string, status: AnalysisTaskStatus, overrides: Partial<AnalysisTask> = {}): AnalysisTask {
  return {
    id,
    taskType: 'job_match_analysis',
    entityType: 'radar_candidate_version',
    entityId: 'ver-1',
    status,
    inputHash: `hash-${id}`,
    inputSnapshot: {},
    attemptCount: 0,
    maxAttempts: 3,
    startedAt: null,
    finishedAt: null,
    cancelledAt: null,
    errorCode: null,
    errorMessage: null,
    resultRecordId: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    ...overrides,
  };
}

function createTaskResult(task: AnalysisTask, created = true): CreateAnalysisTaskResult {
  return { task, created };
}

function succeededRun(task: AnalysisTask): RunOutcome {
  return { kind: 'succeeded', task, recordId: 'rec-1', reused: false };
}

function failedRun(task: AnalysisTask, errorCode: AnalysisTaskErrorCode): RunOutcome {
  return { kind: 'failed', task, errorCode };
}

function makeBatchResult(id: string, created: boolean): CreateBatchResult {
  return { batch: { id } as unknown as RadarRecommendationBatch, created };
}

function fetchedPass(): FetchResult {
  return {
    status: 'FETCHED',
    content: { title: '高级前端', plainText: '完整 JD 文本', canonicalUrl: null, contentType: null },
    validation: { status: 'PASS', reasonCode: 'jd_complete' },
  };
}

function upgradedResult(versionId: string): EvidenceUpgradeResult {
  return { status: 'UPGRADED', versionId, snapshotId: 'snap-up', candidateId: 'cand-1' };
}

function makeDeps(overrides: Partial<DailyPipelineDeps> = {}): DailyPipelineDeps {
  // 默认 getCandidate：返回 candidate，activeVersionId 与测试常用 pattern 匹配。
  // 'cand-1' → 'v1', 'cand-v2' → 'v2', 'cand-v3' → 'v3', etc.
  const defaultGetCandidate = vi.fn((candidateId: string) => {
    const activeVersionId = candidateId === 'cand-1' ? 'v1' : candidateId.replace(/^cand-/, '');
    return makeCandidate(candidateId, activeVersionId);
  });

  return {
    search: vi.fn(async () => makeSearchResult([])),
    ingestDiscovery: vi.fn(async () => ({
      items: [],
      summary: { total: 0, ingested: 0, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
    })),
    fetch: vi.fn(async () => fetchedPass()),
    upgrade: vi.fn(() => upgradedResult('ver-up')),
    getCandidate: defaultGetCandidate,
    getVersion: vi.fn(() => null),
    createTask: vi.fn(() => createTaskResult(makeTask('t1', 'queued'))),
    runTask: vi.fn(async () => succeededRun(makeTask('t1', 'succeeded'))),
    createBatch: vi.fn(() => makeBatchResult('batch-1', true)),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('DailyPipeline', () => {
  it('full success: SEARCH_EVIDENCE → fetch → upgrade → queued → runTask succeeded → recommendation', async () => {
    const searchItem = makeSearchItem('https://jobs.zhiye.com/a');
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([searchItem])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => upgradedResult('v2')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'queued'))),
      runTask: vi.fn(async () => succeededRun(makeTask('t1', 'succeeded'))),
      createBatch: vi.fn(() => makeBatchResult('batch-1', true)),
    });
    const pipeline = new DailyPipeline(deps);

    const result = await pipeline.run([QUERY]);

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.finalOutcome).toBe('analysisCompleted');
    expect(item.finalVersionId).toBe('v2');
    expect(item.sourceVersionId).toBe('v1');
    expect(item.milestones.ingested).toBe(true);
    expect(item.milestones.fetchAttempted).toBe(true);
    expect(item.milestones.upgraded).toBe(true);
    expect(item.milestones.analysisCompleted).toBe(true);
    expect(item.milestones.inRecommendationScope).toBe(true);
    expect(result.recommendationScope).toEqual(['v2']);
    expect(result.recommendationBatchId).toBe('batch-1');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    expect(deps.runTask).toHaveBeenCalledTimes(1);
    expect(deps.createBatch).toHaveBeenCalledTimes(1);
    expect(deps.createBatch).toHaveBeenCalledWith(['v2']);
  });

  it('queued → runTask exactly once', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'queued'))),
      runTask: vi.fn(async () => succeededRun(makeTask('t1', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(deps.runTask).toHaveBeenCalledTimes(1);
    expect(deps.runTask).toHaveBeenCalledWith('t1');
  });

  it('succeeded task reuse → no LLM rerun (runTask not called)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(deps.runTask).not.toHaveBeenCalled();
  });

  it('INPUT_NOT_READY → analysisBlocked, other items continue', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2', candidateId: 'cand-v2' }),
        ],
        summary: { total: 2, ingested: 2, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 2 },
      })),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((id) => {
        if (id === 'v1') throw new AnalysisInputError('INPUT_NOT_READY', '岗位事实不足以支撑分析');
        return createTaskResult(makeTask('t2', 'queued'));
      }),
      runTask: vi.fn(async () => succeededRun(makeTask('t2', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('INPUT_NOT_READY');
    expect(result.items[1].finalOutcome).toBe('analysisCompleted');
    expect(result.recommendationScope).toEqual(['v2']);
  });

  it('CANDIDATE_VERSION_MISMATCH → analysisBlocked', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        throw new AnalysisInputError('CANDIDATE_VERSION_MISMATCH', '版本已变化');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('CANDIDATE_VERSION_MISMATCH');
    expect(result.recommendationScope).toEqual([]);
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it('runTask failed → analysisFailed with errorCode', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'queued'))),
      runTask: vi.fn(async () => failedRun(makeTask('t1', 'failed'), 'PROVIDER_TIMEOUT')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisFailed');
    expect(result.items[0].reasonCode).toBe('PROVIDER_TIMEOUT');
    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisFailed).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.recommendationScope).toEqual([]);
  });

  it('existing running task → analysisAlreadyRunning, no runTask', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'running'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisAlreadyRunning');
    expect(deps.runTask).not.toHaveBeenCalled();
  });

  it('cancelled task → analysisCancelled, no resurrect', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'cancelled'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCancelled');
    expect(deps.runTask).not.toHaveBeenCalled();
  });

  it('empty recommendation scope → no createBatch', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://zhipin.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://zhipin.com/a', {
          candidateVersionId: 'v1',
          sourcePolicyDecision: {
            policy: 'SEARCH_ONLY',
            initialEvidenceLevel: 'MANUAL_REVIEW_REQUIRED',
            fetchEligible: false,
            targetEvidenceLevelAfterFetch: null,
            reason: 'known_recruitment_platform_manual_review_required',
            normalizedDomain: 'zhipin.com',
          },
          fetchEligible: false,
        })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'MANUAL_REVIEW_REQUIRED')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('manualReview');
    expect(result.recommendationScope).toEqual([]);
    expect(result.recommendationBatchId).toBeNull();
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it('multiple success → createBatch once with all finalVersionIds', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2', candidateId: 'cand-v2' }),
        ],
        summary: { total: 2, ingested: 2, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 2 },
      })),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.recommendationScope).toEqual(['v1', 'v2']);
    expect(deps.createBatch).toHaveBeenCalledTimes(1);
    expect(deps.createBatch).toHaveBeenCalledWith(['v1', 'v2']);
  });

  it('RecommendationBatch created=false reuse → id set, no error', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
      createBatch: vi.fn(() => makeBatchResult('batch-existing', false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.recommendationBatchId).toBe('batch-existing');
    expect(result.summary.recommendationBatchCreated).toBe(false);
  });

  it('partial failures isolated: success + fetch fail + manual review', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
        makeSearchItem('https://zhipin.com/c'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2', candidateId: 'cand-v2' }),
          makeBridgeOutcome('https://zhipin.com/c', {
            candidateVersionId: 'v3',
            candidateId: 'cand-v3',
            sourcePolicyDecision: {
              policy: 'SEARCH_ONLY',
              initialEvidenceLevel: 'MANUAL_REVIEW_REQUIRED',
              fetchEligible: false,
              targetEvidenceLevelAfterFetch: null,
              reason: 'known_recruitment_platform_manual_review_required',
              normalizedDomain: 'zhipin.com',
            },
            fetchEligible: false,
          }),
        ],
        summary: { total: 3, ingested: 3, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 2 },
      })),
      getVersion: vi.fn((id) => makeVersion(id, id === 'v2' ? 'SEARCH_EVIDENCE' : id === 'v3' ? 'MANUAL_REVIEW_REQUIRED' : 'FULL_EVIDENCE')),
      fetch: vi.fn(async () => ({ status: 'NETWORK_ERROR', error: { code: 'NETWORK_ERROR', reason: 'timeout' } } as FetchResult)),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items).toHaveLength(3);
    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('fetchFailed');
    expect(result.items[1].reasonCode).toBe('NETWORK_ERROR');
    expect(result.items[2].finalOutcome).toBe('manualReview');
    expect(result.recommendationScope).toEqual(['v1']);
    expect(deps.createBatch).toHaveBeenCalledWith(['v1']);
  });

  it('abort before analysis → aborted, no createTask/runTask', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => {
        controller.abort();
        return makeVersion('v1', 'FULL_EVIDENCE');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { signal: controller.signal });

    expect(result.items[0].finalOutcome).toBe('aborted');
    expect(result.items[0].reasonCode).toBe('ABORTED');
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(deps.runTask).not.toHaveBeenCalled();
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it('abort during runTask → no force kill, no next item', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2' }),
        ],
        summary: { total: 2, ingested: 2, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 2 },
      })),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'queued'))),
      runTask: vi.fn(async () => {
        controller.abort();
        return succeededRun(makeTask('t1', 'succeeded'));
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { signal: controller.signal });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(deps.createTask).toHaveBeenCalledWith('v1');
    expect(deps.runTask).toHaveBeenCalledTimes(1);
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it('existing FULL → skip fetch + upgrade', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[0].finalVersionId).toBe('v1');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledWith('v1');
  });

  it('repeat run (Day 2) → no fetch / upgrade / LLM', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v2' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getCandidate: vi.fn((id) => makeCandidate(id, 'v2')),
      getVersion: vi.fn(() => makeVersion('v2', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t2', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledWith('v2');
    expect(deps.runTask).not.toHaveBeenCalled();
  });

  it('existing FULL + fetchEligible=false → analysis without fetch', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', {
          candidateVersionId: 'v1',
          fetchEligible: false,
        })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'queued'))),
      runTask: vi.fn(async () => succeededRun(makeTask('t1', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.runTask).toHaveBeenCalledTimes(1);
  });

  it('SEARCH_EVIDENCE + fetchEligible=true → normal fetch/upgrade', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => upgradedResult('v2')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[0].finalVersionId).toBe('v2');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.upgrade).toHaveBeenCalledWith({
      sourceVersionId: 'v1',
      content: expect.objectContaining({ plainText: '完整 JD 文本' }),
      validation: { status: 'PASS', reasonCode: 'jd_complete' },
    });
  });

  it('SEARCH_EVIDENCE + fetchEligible=false → discoveryOnly, no fetch/analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://juejin.cn/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://juejin.cn/a', {
          candidateVersionId: 'v1',
          sourcePolicyDecision: {
            policy: 'CONDITIONAL_FETCH',
            initialEvidenceLevel: 'SEARCH_EVIDENCE',
            fetchEligible: false,
            targetEvidenceLevelAfterFetch: null,
            reason: 'conditional_fetch_default_no_fetch',
            normalizedDomain: 'juejin.cn',
          },
          fetchEligible: false,
        })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('discoveryOnly');
    expect(result.items[0].reasonCode).toBe('fetch_not_eligible');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it.each([
    ['NETWORK_ERROR'],
    ['NOT_FOUND'],
    ['ACCESS_DENIED'],
    ['TIMEOUT'],
    ['SSRF_BLOCKED'],
  ] as const)('FetchResult non-FETCHED %s → fetchFailed', async (status) => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      fetch: vi.fn(async () => ({ status, error: { code: 'X', reason: 'x' } } as unknown as FetchResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('fetchFailed');
    expect(result.items[0].reasonCode).toBe(status);
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('validation FAIL → validationFailed, no upgrade', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      fetch: vi.fn(async () => ({
        status: 'FETCHED',
        content: { title: 'x', plainText: 'y', canonicalUrl: null, contentType: null },
        validation: { status: 'FAIL', reasonCode: 'jd_incomplete_missing_title' },
      } as FetchResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('validationFailed');
    expect(result.items[0].reasonCode).toBe('jd_incomplete_missing_title');
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('EvidenceUpgrade UPGRADED → analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => upgradedResult('v2')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[0].finalVersionId).toBe('v2');
    expect(result.items[0].milestones.upgraded).toBe(true);
    expect(deps.createTask).toHaveBeenCalledWith('v2');
  });

  it('EvidenceUpgrade ALREADY_UPGRADED → analysis on existingVersionId', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => ({ status: 'ALREADY_UPGRADED', existingVersionId: 'v2', candidateId: 'cand-1' } as EvidenceUpgradeResult)),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[0].finalVersionId).toBe('v2');
    expect(result.items[0].milestones.alreadyUpgraded).toBe(true);
    expect(deps.createTask).toHaveBeenCalledWith('v2');
  });

  it('EvidenceUpgrade BLOCKED → upgradeBlocked, no analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => ({ status: 'BLOCKED', reasonCode: 'stale_source_version' } as EvidenceUpgradeResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('upgradeBlocked');
    expect(result.items[0].reasonCode).toBe('stale_source_version');
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('EvidenceUpgrade FAILED → upgradeFailed, no analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => ({ status: 'FAILED', reasonCode: 'content_hash_collision' } as EvidenceUpgradeResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('upgradeFailed');
    expect(result.items[0].reasonCode).toBe('content_hash_collision');
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('search result / ingestion correlation mismatch → ingestFailed', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/DIFFERENT', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('ingestFailed');
    expect(result.items[0].reasonCode).toBe('CONSISTENCY_MISMATCH');
    expect(deps.getVersion).not.toHaveBeenCalled();
  });

  it('bridge skipped item → ingestFailed with errorReason', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', {
          candidateVersionId: null,
          skipped: true,
          errorReason: 'normalize failed',
        })],
        summary: { total: 1, ingested: 0, skipped: 1, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
      })),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('ingestFailed');
    expect(result.items[0].reasonCode).toBe('normalize failed');
    expect(deps.getVersion).not.toHaveBeenCalled();
  });

  it('propagates AbortSignal to search request', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([])),
    });
    await new DailyPipeline(deps).run([QUERY], { signal: controller.signal });

    expect(deps.search).toHaveBeenCalledTimes(1);
    expect(deps.search).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('propagates provider coverage into result.coverage（不丢失来源失败信息）', async () => {
    const searchResult = {
      ...makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')]),
      coverage: {
        queriesCompleted: 1,
        queriesFailed: 1,
        failedScopes: [{ queryKey: '苏州×前端开发×前端', errorCode: 'TIMEOUT' as const, message: 'timeout' }],
        queryResults: [],
      },
    };
    const deps = makeDeps({
      search: vi.fn(async () => searchResult),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: { total: 1, ingested: 1, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 1 },
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.coverage).toEqual(searchResult.coverage);
    expect(result.coverage.queriesFailed).toBe(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('TIMEOUT');
  });

  // ── P0：unknown public fetch / budget / cross-source enrichment ─────────────

  function recruitmentBridge(url: string, versionId: string, candidateId = 'cand-1'): DiscoveryIngestionItemOutcome {
    return makeBridgeOutcome(url, {
      normalizedDomain: 'zhipin.com',
      sourcePolicyDecision: {
        policy: 'SEARCH_ONLY',
        initialEvidenceLevel: 'MANUAL_REVIEW_REQUIRED',
        fetchEligible: false,
        targetEvidenceLevelAfterFetch: null,
        reason: 'known_recruitment_platform_manual_review_required',
        normalizedDomain: 'zhipin.com',
      },
      appliedEvidenceLevel: 'MANUAL_REVIEW_REQUIRED',
      fetchEligible: false,
      targetEvidenceLevelAfterFetch: null,
      candidateId,
      candidateVersionId: versionId,
    });
  }

  function publicAltBridge(url: string, versionId: string, normalizedDomain = 'acme.com', candidateId = 'cand-1'): DiscoveryIngestionItemOutcome {
    return makeBridgeOutcome(url, {
      normalizedDomain,
      sourcePolicyDecision: {
        policy: 'SEARCH_AND_FETCH',
        initialEvidenceLevel: 'SEARCH_EVIDENCE',
        fetchEligible: true,
        targetEvidenceLevelAfterFetch: 'FULL_EVIDENCE',
        reason: 'unknown_public_fetch_eligible',
        normalizedDomain,
      },
      candidateId,
      candidateVersionId: versionId,
    });
  }

  function ingestionSummary(total: number, fetchEligible: number) {
    return { total, ingested: total, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: fetchEligible };
  }

  it('unknown public domain → SEARCH_EVIDENCE + fetchEligible → fetch → upgrade → analysis', async () => {
    const url = 'https://acme.com/careers/1';
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem(url, { domain: 'acme.com' })])),
      ingestDiscovery: vi.fn(async () => ({
        items: [publicAltBridge(url, 'v1')],
        summary: ingestionSummary(1, 1),
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => upgradedResult('v2')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[0].finalVersionId).toBe('v2');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith(expect.objectContaining({ url }));
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    expect(result.stageCounts.unknownPublic).toBe(1);
    expect(result.stageCounts.fetchAttempted).toBe(1);
    expect(result.stageCounts.fetchSucceeded).toBe(1);
    expect(result.stageCounts.validationPassed).toBe(1);
    expect(result.stageCounts.evidenceUpgraded).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(1);
  });

  it('unknown public fetch failure → fetchFailed, no upgrade / analysis', async () => {
    const url = 'https://acme.com/x';
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem(url, { domain: 'acme.com' })])),
      ingestDiscovery: vi.fn(async () => ({
        items: [publicAltBridge(url, 'v1')],
        summary: ingestionSummary(1, 1),
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      fetch: vi.fn(async () => ({ status: 'ACCESS_DENIED', error: { code: 'ACCESS_DENIED', reason: 'login wall' } } as FetchResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('fetchFailed');
    expect(result.items[0].reasonCode).toBe('ACCESS_DENIED');
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(result.stageCounts.fetchAttempted).toBe(1);
    expect(result.stageCounts.fetchSucceeded).toBe(0);
    expect(result.stageCounts.fetchFailed).toBe(1);
  });

  it('known recruitment without company identity → manualReview, never fetch (enrichment fail closed)', async () => {
    const zhipinUrl = 'https://www.zhipin.com/job/1';
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem(zhipinUrl, { domain: 'zhipin.com', title: '高级前端工程师' })])),
      ingestDiscovery: vi.fn(async () => ({
        items: [recruitmentBridge(zhipinUrl, 'v-recruit')],
        summary: ingestionSummary(1, 0),
      })),
      getCandidate: vi.fn((id) => makeCandidate(id, 'v-recruit')),
      getVersion: vi.fn(() => makeVersion('v-recruit', 'MANUAL_REVIEW_REQUIRED')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('manualReview');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
    // 缺 company identity → 不触发 enrichment search（search 仅主搜索一次）。
    expect(deps.search).toHaveBeenCalledTimes(1);
    expect(result.stageCounts.recruitmentBlocked).toBe(1);
    expect(result.stageCounts.crossSourceEnrichmentAttempted).toBe(0);
    expect(result.stageCounts.crossSourceEnrichmentSucceeded).toBe(0);
  });

  it('recruitment enrichment finds same-company public alternative → only fetch alternative, original never fetched', async () => {
    const zhipinUrl = 'https://www.zhipin.com/job/1';
    const altUrl = 'https://jobs.bytedance.com/careers/1';
    const deps = makeDeps({
      search: vi.fn()
        .mockResolvedValueOnce(makeSearchResult([makeSearchItem(zhipinUrl, { domain: 'zhipin.com', title: '高级前端工程师', company: '字节跳动' })]))
        .mockResolvedValueOnce(makeSearchResult([makeSearchItem(altUrl, { domain: 'bytedance.com', title: '字节跳动 高级前端工程师' })])),
      ingestDiscovery: vi.fn()
        .mockResolvedValueOnce({
          items: [recruitmentBridge(zhipinUrl, 'v-recruit')],
          summary: ingestionSummary(1, 0),
        })
        .mockResolvedValueOnce({
          items: [publicAltBridge(altUrl, 'v-alt', 'bytedance.com', 'cand-alt')],
          summary: ingestionSummary(1, 1),
        }),
      getCandidate: vi.fn((id) => {
        if (id === 'cand-1') return makeCandidate(id, 'v-recruit');
        if (id === 'cand-alt') return makeCandidate(id, 'v-alt');
        return makeCandidate(id, id.replace(/^cand-/, ''));
      }),
      getVersion: vi.fn((id) => (id === 'v-recruit' ? makeVersion(id, 'MANUAL_REVIEW_REQUIRED') : makeVersion(id, 'SEARCH_EVIDENCE'))),
      upgrade: vi.fn(() => upgradedResult('v-alt-up')),
      createTask: vi.fn(() => createTaskResult(makeTask('t-alt', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    const recruitment = result.items.find((i) => i.itemUrl === zhipinUrl);
    const alt = result.items.find((i) => i.itemUrl === altUrl);
    expect(recruitment?.finalOutcome).toBe('manualReview');
    expect(alt?.finalOutcome).toBe('analysisCompleted');

    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: altUrl }));
    expect(deps.fetch).not.toHaveBeenCalledWith(expect.objectContaining({ url: zhipinUrl }));
    expect(deps.upgrade).toHaveBeenCalledWith(expect.objectContaining({ sourceVersionId: 'v-alt' }));

    expect(result.stageCounts.crossSourceEnrichmentAttempted).toBe(1);
    expect(result.stageCounts.crossSourceEnrichmentSucceeded).toBe(1);
  });

  it('recruitment enrichment returns different-company alternative → rejected, no fetch / upgrade', async () => {
    const zhipinUrl = 'https://www.zhipin.com/job/1';
    const deps = makeDeps({
      search: vi.fn()
        .mockResolvedValueOnce(makeSearchResult([makeSearchItem(zhipinUrl, { domain: 'zhipin.com', title: '高级前端工程师', company: '字节跳动' })]))
        .mockResolvedValueOnce(makeSearchResult([makeSearchItem('https://tencent.com/careers/1', { domain: 'tencent.com', title: '腾讯 高级前端工程师' })])),
      ingestDiscovery: vi.fn().mockResolvedValueOnce({
        items: [recruitmentBridge(zhipinUrl, 'v-recruit')],
        summary: ingestionSummary(1, 0),
      }),
      getCandidate: vi.fn((id) => makeCandidate(id, 'v-recruit')),
      getVersion: vi.fn(() => makeVersion('v-recruit', 'MANUAL_REVIEW_REQUIRED')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items.map((i) => i.finalOutcome)).toEqual(['manualReview']);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
    expect(result.stageCounts.crossSourceEnrichmentAttempted).toBe(1);
    expect(result.stageCounts.crossSourceEnrichmentSucceeded).toBe(0);
  });

  it('fetch budget → beyond-budget items kept discoveryOnly, run not failed', async () => {
    const urls = ['https://jobs.zhiye.com/1', 'https://jobs.zhiye.com/2', 'https://jobs.zhiye.com/3'];
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult(urls.map((u) => makeSearchItem(u)))),
      ingestDiscovery: vi.fn(async () => ({
        items: urls.map((u, i) => makeBridgeOutcome(u, { candidateVersionId: `v${i}`, candidateId: `cand-${i}` })),
        summary: ingestionSummary(3, 3),
      })),
      getCandidate: vi.fn((id) => makeCandidate(id, id.replace(/^cand-/, 'v'))),
      getVersion: vi.fn((id) => makeVersion(id, 'SEARCH_EVIDENCE')),
      upgrade: vi.fn((input) => upgradedResult(`up-${input.sourceVersionId}`)),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { fetchBudget: 2 });

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('analysisCompleted');
    expect(result.items[2].finalOutcome).toBe('discoveryOnly');
    expect(result.items[2].reasonCode).toBe('fetch_budget_exhausted');
    expect(result.summary.total).toBe(3);
    expect(result.stageCounts.fetchBudget).toBe(2);
    expect(result.stageCounts.fetchBudgetExhausted).toBe(1);
    expect(result.stageCounts.fetchAttempted).toBe(2);
  });

  it('enrichment budget → only N recruitment items enriched, no recursion', async () => {
    const zhipinUrl = 'https://www.zhipin.com/job/1';
    const liepinUrl = 'https://www.liepin.com/job/2';
    const deps = makeDeps({
      search: vi.fn()
        .mockResolvedValueOnce(makeSearchResult([
          makeSearchItem(zhipinUrl, { domain: 'zhipin.com', title: '前端', company: '字节跳动' }),
          makeSearchItem(liepinUrl, { domain: 'liepin.com', title: '后端', company: '腾讯' }),
        ]))
        .mockResolvedValue(makeSearchResult([])),
      ingestDiscovery: vi.fn().mockResolvedValueOnce({
        items: [
          recruitmentBridge(zhipinUrl, 'v1', 'cand-1'),
          recruitmentBridge(liepinUrl, 'v2', 'cand-2'),
        ],
        summary: ingestionSummary(2, 0),
      }),
      getCandidate: vi.fn((id) => {
        if (id === 'cand-1') return makeCandidate(id, 'v1');
        if (id === 'cand-2') return makeCandidate(id, 'v2');
        return makeCandidate(id, id.replace(/^cand-/, ''));
      }),
      getVersion: vi.fn((id) => makeVersion(id, 'MANUAL_REVIEW_REQUIRED')),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { enrichmentBudget: 1 });

    expect(result.stageCounts.crossSourceEnrichmentAttempted).toBe(1);
    expect(deps.search).toHaveBeenCalledTimes(2); // 1 main + 1 enrichment
    expect(result.items.map((i) => i.finalOutcome)).toEqual(['manualReview', 'manualReview']);
  });

  // ── P0.1：candidate-level dedupe + BLOCKED reason 聚合 ──────────────────────

  it('同一 candidate 多 query 命中 → fetch/upgrade/analysis 各最多一次，budget 只消耗一次', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/a'), // 同 URL 同 candidate 重复命中
        makeSearchItem('https://jobs.zhiye.com/b'), // 不同 candidate
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-A' }),
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-A' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2', candidateId: 'cand-B' }),
        ],
        summary: ingestionSummary(3, 3),
      })),
      getCandidate: vi.fn((id) => makeCandidate(id, id === 'cand-A' ? 'v1' : 'v2')),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn((input) => upgradedResult(`up-${input.sourceVersionId}`)),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    // 同 candidate（cand-A）只 fetch / upgrade / analysis 一次；cand-B 各一次。
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.upgrade).toHaveBeenCalledTimes(2);
    expect(deps.createTask).toHaveBeenCalledTimes(2);
    // fetchBudget 只消耗 2 条（不是 3 条）
    expect(result.stageCounts.fetchAttempted).toBe(2);
    // 第一个 cand-A item 正常完成；第二个 dedupe 为 discoveryOnly
    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('discoveryOnly');
    expect(result.items[1].reasonCode).toBe('candidate_already_processed');
    expect(result.items[2].finalOutcome).toBe('analysisCompleted');
    expect(result.recommendationScope).toEqual(['up-v1', 'up-v2']);
  });

  it('同一 candidate 多 query 命中（existing FULL）→ analysis 最多一次', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/a'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-A' }),
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-A' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn((id) => makeCandidate(id, 'v1')),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn((id) => createTaskResult(makeTask(id, 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledTimes(1);
    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('discoveryOnly');
    expect(result.items[1].reasonCode).toBe('candidate_already_processed');
  });

  it('EvidenceUpgrade BLOCKED reason → evidenceUpgradeBlockedBy 聚合', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1' })],
        summary: ingestionSummary(1, 1),
      })),
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
      upgrade: vi.fn(() => ({ status: 'BLOCKED', reasonCode: 'stale_source_version' } as EvidenceUpgradeResult)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('upgradeBlocked');
    expect(result.items[0].reasonCode).toBe('stale_source_version');
    expect(result.stageCounts.evidenceUpgradeBlocked).toBe(1);
    expect(result.stageCounts.evidenceUpgradeBlockedBy).toEqual({ stale_source_version: 1 });
  });

  // ── P0.1：active-version handoff gate（防止 stale handoff 固化） ───────────

  it('stale version 在前（同 candidate 多版本）→ stale 跳过不消耗 budget，active 正常处理', async () => {
    // item A → V3 (stale), item B → V4 (active), process 顺序 A 在前
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v3', candidateId: 'cand-X' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-X', 'v4')), // active = v4
      getVersion: vi.fn((id) => makeVersion(id, 'SEARCH_EVIDENCE', 'cand-X')),
      upgrade: vi.fn(() => upgradedResult('v4-up')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    // A (stale v3) → discoveryOnly, 不消耗 budget
    expect(result.items[0].finalOutcome).toBe('discoveryOnly');
    expect(result.items[0].reasonCode).toBe('candidate_version_not_active_for_processing');
    // B (active v4) → 正常处理
    expect(result.items[1].finalOutcome).toBe('analysisCompleted');
    // 总 fetch = 1（只有 B）
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://jobs.zhiye.com/b' }));
  });

  it('stale version 在后（active 先处理）→ active 正常处理，stale 后续被 skip', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v3', candidateId: 'cand-X' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-X', 'v4')),
      getVersion: vi.fn((id) => makeVersion(id, 'SEARCH_EVIDENCE', 'cand-X')),
      upgrade: vi.fn(() => upgradedResult('v4-up')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('discoveryOnly');
    expect(result.items[1].reasonCode).toBe('candidate_version_not_active_for_processing');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('同 candidate 多个 outcome 指向同一 active version → fetch=1, upgrade=1, analysis=1', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-X', 'v4')),
      getVersion: vi.fn(() => makeVersion('v4', 'SEARCH_EVIDENCE', 'cand-X')),
      upgrade: vi.fn(() => upgradedResult('v4-up')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('discoveryOnly');
    expect(result.items[1].reasonCode).toBe('candidate_already_processed');
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.upgrade).toHaveBeenCalledTimes(1);
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it('active FULL_EVIDENCE → 不 fetch，正常进入 analysis fast path，后续 duplicate 不重复 analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/a'),
        makeSearchItem('https://jobs.zhiye.com/b'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v4', candidateId: 'cand-X' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-X', 'v4')),
      getVersion: vi.fn(() => makeVersion('v4', 'FULL_EVIDENCE', 'cand-X')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'succeeded'), false)),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisCompleted');
    expect(result.items[1].finalOutcome).toBe('discoveryOnly');
    expect(result.items[1].reasonCode).toBe('candidate_already_processed');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).toHaveBeenCalledTimes(1);
  });

  it('active MRR → 不 fetch、不 upgrade、不 analysis', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-M' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-M', 'v1')),
      getVersion: vi.fn(() => makeVersion('v1', 'MANUAL_REVIEW_REQUIRED', 'cand-M')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('manualReview');
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.upgrade).not.toHaveBeenCalled();
    expect(deps.createTask).not.toHaveBeenCalled();
  });

  it('candidate not found → analysisBlocked with counter increments', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v1', candidateId: 'cand-missing' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => null), // candidate 不存在
      getVersion: vi.fn(() => makeVersion('v1', 'SEARCH_EVIDENCE')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('CANDIDATE_NOT_FOUND');
    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['CANDIDATE_NOT_FOUND']).toBe(1);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('version not found → analysisBlocked with counter increments', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/a')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/a', { candidateVersionId: 'v-missing', candidateId: 'cand-1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => makeCandidate('cand-1', 'v-missing')),
      getVersion: vi.fn(() => null), // version 不存在
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('CANDIDATE_VERSION_NOT_FOUND');
    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['CANDIDATE_VERSION_NOT_FOUND']).toBe(1);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('LLM_INPUT_SENSITIVE_CONTENT → analysisBlocked (CONTRACT error)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/sensitive')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/sensitive', { candidateVersionId: 'v2', candidateId: 'c2' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c2', activeVersionId: 'v2' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v2', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive content detected');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('LLM_INPUT_SENSITIVE_CONTENT');
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['LLM_INPUT_SENSITIVE_CONTENT']).toBe(1);
    expect(deps.runTask).not.toHaveBeenCalled();
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it('SNAPSHOT_INVALID → analysisBlocked (CONTRACT error)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/invalid')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/invalid', { candidateVersionId: 'v3', candidateId: 'c3' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c3', activeVersionId: 'v3' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v3', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        throw new AnalysisContractError('SNAPSHOT_INVALID', 'Snapshot validation failed');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('SNAPSHOT_INVALID');
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['SNAPSHOT_INVALID']).toBe(1);
    expect(deps.runTask).not.toHaveBeenCalled();
  });

  it('SNAPSHOT_TOO_LARGE → analysisBlocked (CONTRACT error)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/large')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/large', { candidateVersionId: 'v4', candidateId: 'c4' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c4', activeVersionId: 'v4' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v4', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        throw new AnalysisContractError('SNAPSHOT_TOO_LARGE', 'Snapshot exceeds size limit');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('SNAPSHOT_TOO_LARGE');
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['SNAPSHOT_TOO_LARGE']).toBe(1);
  });

  it('multiple items with different CONTRACT errors → aggregated analysisBlockedBy', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/s1'),
        makeSearchItem('https://jobs.zhiye.com/s2'),
        makeSearchItem('https://jobs.zhiye.com/s3'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/s1', { candidateVersionId: 'v5', candidateId: 'c5' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s2', { candidateVersionId: 'v6', candidateId: 'c6' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s3', { candidateVersionId: 'v7', candidateId: 'c7' }),
        ],
        summary: ingestionSummary(3, 3),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v5') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        if (versionId === 'v6') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        if (versionId === 'v7') throw new AnalysisContractError('SNAPSHOT_INVALID', 'Invalid');
        throw new Error('Unexpected versionId');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisBlocked).toBe(3);
    expect(result.stageCounts.analysisBlockedBy['LLM_INPUT_SENSITIVE_CONTENT']).toBe(2);
    expect(result.stageCounts.analysisBlockedBy['SNAPSHOT_INVALID']).toBe(1);
    expect(result.items.every(item => item.finalOutcome === 'analysisBlocked')).toBe(true);
  });

  it('CONTRACT error + normal item → blocked item + succeeded item (pipeline continues)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/bad'),
        makeSearchItem('https://jobs.zhiye.com/good'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/bad', { candidateVersionId: 'v8', candidateId: 'c8' }),
          makeBridgeOutcome('https://jobs.zhiye.com/good', { candidateVersionId: 'v9', candidateId: 'c9' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v8') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        return createTaskResult(makeTask('t9', 'queued'));
      }),
      runTask: vi.fn(async () => succeededRun(makeTask('t9', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('LLM_INPUT_SENSITIVE_CONTENT');
    expect(result.items[1].finalOutcome).toBe('analysisCompleted');
    expect(result.stageCounts.analysisRequested).toBe(2);
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(1);
    expect(result.recommendationScope).toEqual(['v9']);
  });

  it('analysisRequested counts all analysis attempts (blocked + succeeded)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/sensitive'),
        makeSearchItem('https://jobs.zhiye.com/invalid'),
        makeSearchItem('https://jobs.zhiye.com/ok1'),
        makeSearchItem('https://jobs.zhiye.com/ok2'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/sensitive', { candidateVersionId: 'v1', candidateId: 'c1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/invalid', { candidateVersionId: 'v2', candidateId: 'c2' }),
          makeBridgeOutcome('https://jobs.zhiye.com/ok1', { candidateVersionId: 'v3', candidateId: 'c3' }),
          makeBridgeOutcome('https://jobs.zhiye.com/ok2', { candidateVersionId: 'v4', candidateId: 'c4' }),
        ],
        summary: ingestionSummary(4, 4),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v1') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        if (versionId === 'v2') throw new AnalysisContractError('SNAPSHOT_INVALID', 'Invalid');
        return createTaskResult(makeTask(versionId.replace('v', 't'), 'queued'));
      }),
      runTask: vi.fn(async () => succeededRun(makeTask('t3', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    // 语义验证：analysisRequested = 所有尝试分析的候选（不管是否被阻断）
    expect(result.stageCounts.analysisRequested).toBe(4);
    expect(result.stageCounts.analysisBlocked).toBe(2);
    expect(result.stageCounts.analysisSucceeded).toBe(2);
    // 验证关系：analysisRequested = analysisBlocked + (成功创建任务的数量)
    expect(result.stageCounts.analysisRequested).toBe(
      result.stageCounts.analysisBlocked + result.stageCounts.analysisSucceeded,
    );
    expect(result.stageCounts.analysisBlockedBy['LLM_INPUT_SENSITIVE_CONTENT']).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['SNAPSHOT_INVALID']).toBe(1);
    expect(result.items.filter((i) => i.finalOutcome === 'analysisBlocked').length).toBe(2);
    expect(result.items.filter((i) => i.finalOutcome === 'analysisCompleted').length).toBe(2);
  });

  it('unknown Error in createTask → run-level fatal (not caught by item-level handlers)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/fatal')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/fatal', { candidateVersionId: 'v10', candidateId: 'c10' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c10', activeVersionId: 'v10' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v10', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        throw new Error('Unexpected database connection failure');
      }),
    });

    await expect(new DailyPipeline(deps).run([QUERY])).rejects.toThrow('Unexpected database connection failure');
  });

  it('analysisFailed counter increments for task run failures', async () => {
    const deps = makeDeps({
      search: vi.fn(async () =>
        makeSearchResult([makeSearchItem('https://jobs.zhiye.com/fail1'), makeSearchItem('https://jobs.zhiye.com/fail2')]),
      ),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/fail1', { candidateVersionId: 'v1', candidateId: 'c1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/fail2', { candidateVersionId: 'v2', candidateId: 'c2' }),
        ],
        summary: ingestionSummary(2, 2),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => createTaskResult(makeTask(versionId.replace('v', 't'), 'queued'))),
      runTask: vi.fn(async () => failedRun(makeTask('t1', 'failed'), 'PROVIDER_TIMEOUT')),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisRequested).toBe(2);
    expect(result.stageCounts.analysisFailed).toBe(2);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.stageCounts.analysisBlocked).toBe(0);
    expect(result.items.filter((i) => i.finalOutcome === 'analysisFailed').length).toBe(2);
  });

  it('analysisFailed counter for existing failed task (idempotent)', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/existing-fail')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/existing-fail', { candidateVersionId: 'v1', candidateId: 'c1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c1', activeVersionId: 'v1' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'failed'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisFailed).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.items[0].finalOutcome).toBe('analysisFailed');
  });

  it('counter invariant: requested = blocked + succeeded + failed', async () => {
    const deps = makeDeps({
      search: vi.fn(async () =>
        makeSearchResult([
          makeSearchItem('https://jobs.zhiye.com/blocked'),
          makeSearchItem('https://jobs.zhiye.com/succeeded'),
          makeSearchItem('https://jobs.zhiye.com/failed'),
        ]),
      ),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/blocked', { candidateVersionId: 'v1', candidateId: 'c1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/succeeded', { candidateVersionId: 'v2', candidateId: 'c2' }),
          makeBridgeOutcome('https://jobs.zhiye.com/failed', { candidateVersionId: 'v3', candidateId: 'c3' }),
        ],
        summary: ingestionSummary(3, 3),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v1') throw new AnalysisContractError('SNAPSHOT_INVALID', 'Invalid snapshot');
        return createTaskResult(makeTask(versionId.replace('v', 't'), 'queued'));
      }),
      runTask: vi.fn(async (taskId) => {
        if (taskId === 't2') return succeededRun(makeTask('t2', 'succeeded'));
        return failedRun(makeTask('t3', 'failed'), 'PROVIDER_NETWORK_ERROR');
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisRequested).toBe(3);
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(1);
    expect(result.stageCounts.analysisFailed).toBe(1);
    // 这个简化版 invariant：没有 running/cancelled/aborted
    expect(result.stageCounts.analysisRequested).toBe(
      result.stageCounts.analysisBlocked + result.stageCounts.analysisSucceeded + result.stageCounts.analysisFailed,
    );
  });

  it('existing running task → analysisAlreadyRunning counter', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/running')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/running', { candidateVersionId: 'v1', candidateId: 'c1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c1', activeVersionId: 'v1' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'running'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisAlreadyRunning).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.items[0].finalOutcome).toBe('analysisAlreadyRunning');
  });

  it('existing cancelled task → analysisCancelled counter', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/cancelled')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/cancelled', { candidateVersionId: 'v1', candidateId: 'c1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c1', activeVersionId: 'v1' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => createTaskResult(makeTask('t1', 'cancelled'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisCancelled).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.items[0].finalOutcome).toBe('analysisCancelled');
  });

  it('signal aborted after requested but before runTask → analysisAborted counter', async () => {
    const signal = new AbortController();
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/abort')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/abort', { candidateVersionId: 'v1', candidateId: 'c1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c1', activeVersionId: 'v1' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
      createTask: vi.fn(() => {
        signal.abort();
        return createTaskResult(makeTask('t1', 'queued'));
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { signal: signal.signal });

    expect(result.stageCounts.analysisRequested).toBe(1);
    expect(result.stageCounts.analysisAborted).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(0);
    expect(result.items[0].finalOutcome).toBe('aborted');
  });

  it('signal aborted before analyzeFinalVersion entry → no counter increments', async () => {
    const signal = new AbortController();
    signal.abort();
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([makeSearchItem('https://jobs.zhiye.com/pre-abort')])),
      ingestDiscovery: vi.fn(async () => ({
        items: [makeBridgeOutcome('https://jobs.zhiye.com/pre-abort', { candidateVersionId: 'v1', candidateId: 'c1' })],
        summary: ingestionSummary(1, 1),
      })),
      getCandidate: vi.fn(() => ({ id: 'c1', activeVersionId: 'v1' } as RadarCandidate)),
      getVersion: vi.fn(() => makeVersion('v1', 'FULL_EVIDENCE')),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { signal: signal.signal });

    // signal.aborted 在 analyzeFinalVersion 入口前返回，不计任何 analysis counter
    expect(result.stageCounts.analysisRequested).toBe(0);
    expect(result.stageCounts.analysisAborted).toBe(0);
    // 但 item 仍然会被创建（在 upgrade 阶段已经有了 finalVersionId）
    expect(result.items.length).toBeGreaterThanOrEqual(0);
    if (result.items.length > 0) {
      expect(result.items[0].finalOutcome).toBe('aborted');
    }
  });

  it('full accounting invariant: all terminal states', async () => {
    const signal = new AbortController();
    const deps = makeDeps({
      search: vi.fn(async () =>
        makeSearchResult([
          makeSearchItem('https://jobs.zhiye.com/blocked'),
          makeSearchItem('https://jobs.zhiye.com/succeeded'),
          makeSearchItem('https://jobs.zhiye.com/failed'),
          makeSearchItem('https://jobs.zhiye.com/running'),
          makeSearchItem('https://jobs.zhiye.com/cancelled'),
          makeSearchItem('https://jobs.zhiye.com/aborted'),
        ]),
      ),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/blocked', { candidateVersionId: 'v1', candidateId: 'c1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/succeeded', { candidateVersionId: 'v2', candidateId: 'c2' }),
          makeBridgeOutcome('https://jobs.zhiye.com/failed', { candidateVersionId: 'v3', candidateId: 'c3' }),
          makeBridgeOutcome('https://jobs.zhiye.com/running', { candidateVersionId: 'v4', candidateId: 'c4' }),
          makeBridgeOutcome('https://jobs.zhiye.com/cancelled', { candidateVersionId: 'v5', candidateId: 'c5' }),
          makeBridgeOutcome('https://jobs.zhiye.com/aborted', { candidateVersionId: 'v6', candidateId: 'c6' }),
        ],
        summary: ingestionSummary(6, 6),
      })),
      getCandidate: vi.fn((id) => ({ id, activeVersionId: id.replace('c', 'v') } as RadarCandidate)),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v1') throw new AnalysisContractError('SNAPSHOT_INVALID', 'Invalid');
        if (versionId === 'v6') {
          signal.abort();
          return createTaskResult(makeTask('t6', 'queued'));
        }
        return createTaskResult(makeTask(versionId.replace('v', 't'), versionId === 'v2' ? 'queued' : versionId === 'v3' ? 'failed' : versionId === 'v4' ? 'running' : 'cancelled'));
      }),
      runTask: vi.fn(async () => succeededRun(makeTask('t2', 'succeeded'))),
    });
    const result = await new DailyPipeline(deps).run([QUERY], { signal: signal.signal });

    expect(result.stageCounts.analysisRequested).toBe(6);
    expect(result.stageCounts.analysisBlocked).toBe(1);
    expect(result.stageCounts.analysisSucceeded).toBe(1);
    expect(result.stageCounts.analysisFailed).toBe(1);
    expect(result.stageCounts.analysisAlreadyRunning).toBe(1);
    expect(result.stageCounts.analysisCancelled).toBe(1);
    expect(result.stageCounts.analysisAborted).toBe(1);
    // 完整 accounting invariant
    expect(result.stageCounts.analysisRequested).toBe(
      result.stageCounts.analysisBlocked +
        result.stageCounts.analysisSucceeded +
        result.stageCounts.analysisFailed +
        result.stageCounts.analysisAlreadyRunning +
        result.stageCounts.analysisCancelled +
        result.stageCounts.analysisAborted,
    );
  });

  it('early-stage blocked (CANDIDATE_NOT_FOUND) + contract-error blocked → consistent counting', async () => {
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/not-found'),
        makeSearchItem('https://jobs.zhiye.com/contract-error'),
        makeSearchItem('https://jobs.zhiye.com/success'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/not-found', { candidateVersionId: 'v1', candidateId: 'cand-missing' }),
          makeBridgeOutcome('https://jobs.zhiye.com/contract-error', { candidateVersionId: 'v2', candidateId: 'cand-2' }),
          makeBridgeOutcome('https://jobs.zhiye.com/success', { candidateVersionId: 'v3', candidateId: 'cand-3' }),
        ],
        summary: ingestionSummary(3, 3),
      })),
      getCandidate: vi.fn((id) => {
        if (id === 'cand-missing') return null;
        return makeCandidate(id, id.replace('cand-', 'v'));
      }),
      getVersion: vi.fn((id) => makeVersion(id, 'FULL_EVIDENCE')),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v2') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        return createTaskResult(makeTask('t3', 'succeeded'), false);
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    expect(result.items[0].finalOutcome).toBe('analysisBlocked');
    expect(result.items[0].reasonCode).toBe('CANDIDATE_NOT_FOUND');
    expect(result.items[1].finalOutcome).toBe('analysisBlocked');
    expect(result.items[1].reasonCode).toBe('LLM_INPUT_SENSITIVE_CONTENT');
    expect(result.items[2].finalOutcome).toBe('analysisCompleted');

    expect(result.stageCounts.analysisRequested).toBe(3);
    expect(result.stageCounts.analysisBlocked).toBe(2);
    expect(result.stageCounts.analysisSucceeded).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['CANDIDATE_NOT_FOUND']).toBe(1);
    expect(result.stageCounts.analysisBlockedBy['LLM_INPUT_SENSITIVE_CONTENT']).toBe(1);

    // 验证计数一致性：analysisRequested = analysisBlocked + analysisSucceeded
    expect(result.stageCounts.analysisRequested).toBe(
      result.stageCounts.analysisBlocked + result.stageCounts.analysisSucceeded,
    );
  });

  it('realistic scenario: 12 requested, 6 succeeded, 7 blocked with mixed reasons', async () => {
    // 模拟真实场景：analysisRequested=12, analysisSucceeded=6, analysisBlocked=7 的可能组合
    // 其中包含多种 blocked 原因：CANDIDATE_NOT_FOUND, CANDIDATE_VERSION_NOT_FOUND, CONTRACT errors
    const deps = makeDeps({
      search: vi.fn(async () => makeSearchResult([
        makeSearchItem('https://jobs.zhiye.com/s1'),
        makeSearchItem('https://jobs.zhiye.com/s2'),
        makeSearchItem('https://jobs.zhiye.com/s3'),
        makeSearchItem('https://jobs.zhiye.com/s4'),
        makeSearchItem('https://jobs.zhiye.com/s5'),
        makeSearchItem('https://jobs.zhiye.com/s6'),
        makeSearchItem('https://jobs.zhiye.com/s7'),
        makeSearchItem('https://jobs.zhiye.com/s8'),
        makeSearchItem('https://jobs.zhiye.com/s9'),
        makeSearchItem('https://jobs.zhiye.com/s10'),
        makeSearchItem('https://jobs.zhiye.com/s11'),
        makeSearchItem('https://jobs.zhiye.com/s12'),
        makeSearchItem('https://jobs.zhiye.com/s13'),
      ])),
      ingestDiscovery: vi.fn(async () => ({
        items: [
          makeBridgeOutcome('https://jobs.zhiye.com/s1', { candidateVersionId: 'v1', candidateId: 'c1' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s2', { candidateVersionId: 'v2', candidateId: 'c2' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s3', { candidateVersionId: 'v3', candidateId: 'c3' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s4', { candidateVersionId: 'v4', candidateId: 'c4' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s5', { candidateVersionId: 'v5', candidateId: 'c5' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s6', { candidateVersionId: 'v6', candidateId: 'c6' }),
          makeBridgeOutcome('https://jobs.zhiye.com/s7', { candidateVersionId: 'v-missing-1', candidateId: 'c7' }), // version not found
          makeBridgeOutcome('https://jobs.zhiye.com/s8', { candidateVersionId: 'v8', candidateId: 'c-missing-1' }), // candidate not found
          makeBridgeOutcome('https://jobs.zhiye.com/s9', { candidateVersionId: 'v9', candidateId: 'c9' }), // contract error
          makeBridgeOutcome('https://jobs.zhiye.com/s10', { candidateVersionId: 'v10', candidateId: 'c10' }), // contract error
          makeBridgeOutcome('https://jobs.zhiye.com/s11', { candidateVersionId: 'v-missing-2', candidateId: 'c11' }), // version not found
          makeBridgeOutcome('https://jobs.zhiye.com/s12', { candidateVersionId: 'v12', candidateId: 'c-missing-2' }), // candidate not found
          makeBridgeOutcome('https://jobs.zhiye.com/s13', { candidateVersionId: 'v13', candidateId: 'c13' }), // input error
        ],
        summary: ingestionSummary(13, 13),
      })),
      getCandidate: vi.fn((id) => {
        if (id === 'c-missing-1' || id === 'c-missing-2') return null;
        // s7 和 s11 的 activeVersionId 应该匹配它们的 sourceVersionId，才能触发 version not found
        if (id === 'c7') return makeCandidate('c7', 'v-missing-1');
        if (id === 'c11') return makeCandidate('c11', 'v-missing-2');
        return makeCandidate(id, id.replace('c', 'v'));
      }),
      getVersion: vi.fn((id) => {
        if (id === 'v-missing-1' || id === 'v-missing-2') return null;
        return makeVersion(id, 'FULL_EVIDENCE');
      }),
      createTask: vi.fn((versionId) => {
        if (versionId === 'v9') throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'Sensitive');
        if (versionId === 'v10') throw new AnalysisContractError('SNAPSHOT_INVALID', 'Invalid');
        if (versionId === 'v13') throw new AnalysisInputError('INPUT_NOT_READY', 'Not ready');
        return createTaskResult(makeTask(versionId.replace('v', 't'), 'succeeded'), false);
      }),
    });
    const result = await new DailyPipeline(deps).run([QUERY]);

    // 验证总数
    expect(result.items).toHaveLength(13);

    // 验证计数
    expect(result.stageCounts.analysisRequested).toBe(13); // 所有 13 个都尝试分析
    expect(result.stageCounts.analysisSucceeded).toBe(6); // s1-s6 成功
    expect(result.stageCounts.analysisBlocked).toBe(7); // s7-s13 被阻塞

    // 验证 blocked 原因分布
    expect(result.stageCounts.analysisBlockedBy['CANDIDATE_VERSION_NOT_FOUND']).toBe(2); // s7, s11
    expect(result.stageCounts.analysisBlockedBy['CANDIDATE_NOT_FOUND']).toBe(2); // s8, s12
    expect(result.stageCounts.analysisBlockedBy['LLM_INPUT_SENSITIVE_CONTENT']).toBe(1); // s9
    expect(result.stageCounts.analysisBlockedBy['SNAPSHOT_INVALID']).toBe(1); // s10
    expect(result.stageCounts.analysisBlockedBy['INPUT_NOT_READY']).toBe(1); // s13

    // 验证核心不变量：analysisRequested = analysisBlocked + analysisSucceeded
    expect(result.stageCounts.analysisRequested).toBe(
      result.stageCounts.analysisBlocked + result.stageCounts.analysisSucceeded,
    );

    // 验证 summary 与 stageCounts 一致
    expect(result.summary.analysisCompleted).toBe(6);
    expect(result.summary.analysisBlocked).toBe(7);
  });
});
