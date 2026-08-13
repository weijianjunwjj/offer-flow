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
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarEvidenceLevel,
  RadarRecommendationBatch,
} from '../../src/domain/radar';
import type { CreateAnalysisTaskResult } from '../radar/analysis/analysisService';
import type { RunOutcome } from '../radar/analysis/executor';
import type { CreateBatchResult } from '../radar/recommendation/recommendationBatchService';
import { AnalysisInputError } from '../radar/analysis/inputErrors';

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

function makeVersion(id: string, evidenceLevel: RadarEvidenceLevel): RadarCandidateVersion {
  return {
    id,
    candidateId: `cand-${id}`,
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
  return {
    search: vi.fn(async () => makeSearchResult([])),
    ingestDiscovery: vi.fn(async () => ({
      items: [],
      summary: { total: 0, ingested: 0, skipped: 0, byEvidenceLevel: {}, bySourcePolicy: {}, fetchEligibleCount: 0 },
    })),
    fetch: vi.fn(async () => fetchedPass()),
    upgrade: vi.fn(() => upgradedResult('ver-up')),
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
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2' }),
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
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2' }),
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
          makeBridgeOutcome('https://jobs.zhiye.com/b', { candidateVersionId: 'v2' }),
          makeBridgeOutcome('https://zhipin.com/c', {
            candidateVersionId: 'v3',
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
});
