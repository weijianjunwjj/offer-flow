/**
 * v0.9 Phase 2 — Search Evidence Ingestion Service 测试。
 *
 * 覆盖:
 *   - search_discovery snapshot 创建
 *   - SEARCH_EVIDENCE CandidateVersion 创建
 *   - FULL_EVIDENCE 旧路径不变
 *   - evidence_level 非法值被拒绝
 *   - evidenceLevel-aware analysisEligible（Phase 2 hardening）：
 *     SEARCH_EVIDENCE/MANUAL_REVIEW_REQUIRED → false；FULL_EVIDENCE → 走原判定
 *   - Search Evidence 不触发 MatchAnalysis / RecommendationBatch
 *   - v0.8 Radar 回归仍通过
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { SearchEvidenceIngestionService } from './SearchEvidenceIngestionService';
import type { SearchEvidenceItem } from './searchEvidenceTypes';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureRepository } from '../captureRepository';
import { RadarSourceRecordRepository } from '../sourceRecordRepository';
import {
  DAILY_JOB_HUNTER_SCHEMA_VERSION,
  runMigrations,
} from '../../migrations';
import { openDb } from '../../db';

function makeItem(overrides: Partial<SearchEvidenceItem> = {}): SearchEvidenceItem {
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
    providerMetadata: { response_time: 0.45 },
    ...overrides,
  };
}

describe('SearchEvidenceIngestionService', () => {
  let db: Database.Database;
  let service: SearchEvidenceIngestionService;
  let now: number;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    now = Date.now();
    service = new SearchEvidenceIngestionService(db, {
      now: () => now,
      createId: randomUUID,
    });
  });

  it('produces search_discovery snapshot with captureSessionId=null', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    expect(outcome.snapshotId).toBeTruthy();

    const captures = new RadarCaptureRepository(db);
    const snapshot = captures.getSnapshot(outcome.snapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.captureSessionId).toBeNull();
    expect(snapshot!.captureMethod).toBe('search_discovery');
    expect(snapshot!.providerKey).toBe('tavily');
    expect(snapshot!.sourceUrl).toBe(item.url);
    expect(snapshot!.pageTitle).toBe(item.title);
    expect(snapshot!.visibleText).toBe(item.content);
    expect(snapshot!.sourceDomain).toBe('zhipin.com');
  });

  it('creates SEARCH_EVIDENCE CandidateVersion for new identity', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    expect(outcome.candidateId).toBeTruthy();
    expect(outcome.candidateVersionId).toBeTruthy();
    expect(outcome.sourceRecordId).toBeTruthy();
    expect(outcome.evidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(outcome.decisionType).toBe('new_identity');

    const repo = new RadarCandidateRepository(db);
    const version = repo.getVersion(outcome.candidateVersionId!);
    expect(version).not.toBeNull();
    expect(version!.evidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(version!.originType).toBe('captured');
    expect(version!.sourceSnapshotIds).toHaveLength(1);
    expect(version!.sourceSnapshotIds[0]).toBe(outcome.snapshotId);

    const candidate = repo.getCandidate(outcome.candidateId!);
    expect(candidate).not.toBeNull();
    expect(candidate!.activeVersionId).toBe(outcome.candidateVersionId);
    expect(candidate!.lifecycleStatus).toBe('active');
  });

  it('creates FULL_EVIDENCE CandidateVersion when explicitly requested', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'FULL_EVIDENCE');

    expect(outcome.evidenceLevel).toBe('FULL_EVIDENCE');
    const version = new RadarCandidateRepository(db).getVersion(outcome.candidateVersionId!);
    expect(version!.evidenceLevel).toBe('FULL_EVIDENCE');
  });

  it('deduplicates by URL — same URL returns existing candidate', () => {
    const item = makeItem();
    const first = service.ingest(item, 'SEARCH_EVIDENCE');
    const second = service.ingest(item, 'SEARCH_EVIDENCE');

    // Same candidate (no_change — content hasn't changed)
    expect(second.candidateId).toBe(first.candidateId);
    expect(second.candidateVersionId).toBe(first.candidateVersionId);
    expect(second.decisionType).toBe('no_change');

    // No duplicate candidate created
    const candidates = new RadarCandidateRepository(db).listActiveCandidates();
    expect(candidates.length).toBe(1);
  });

  it('different URLs create different candidates', () => {
    const item1 = makeItem({ url: 'https://www.zhipin.com/job/1' });
    const item2 = makeItem({ url: 'https://www.zhipin.com/job/2' });

    const out1 = service.ingest(item1, 'SEARCH_EVIDENCE');
    const out2 = service.ingest(item2, 'SEARCH_EVIDENCE');

    expect(out1.candidateId).not.toBe(out2.candidateId);
  });

  it('snapshot rawSnapshot contains Search Evidence metadata', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    const snapshot = new RadarCaptureRepository(db).getSnapshot(outcome.snapshotId);
    const raw = snapshot!.rawSnapshot as Record<string, unknown>;
    expect(raw.provider).toBe('tavily');
    expect(raw.query).toBe(item.query);
    expect(raw.providerScore).toBe(0.85);
  });

  it('rejects evidence_level that violates DB CHECK constraint', () => {
    const item = makeItem();
    expect(() => {
      // Cast to bypass TypeScript
      (service as unknown as { ingest: (item: SearchEvidenceItem, level: string) => unknown }).ingest(item, 'INVALID_LEVEL');
    }).toThrow();
  });

  it('SEARCH_EVIDENCE → analysisEligible=false (evidenceLevel gate)', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    // Phase 2 hardening: evidenceLevel gate blocks analysis for SEARCH_EVIDENCE.
    expect(outcome.analysisEligible).toBe(false);
  });

  it('MANUAL_REVIEW_REQUIRED → analysisEligible=false (evidenceLevel gate)', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'MANUAL_REVIEW_REQUIRED');

    expect(outcome.analysisEligible).toBe(false);
  });

  it('FULL_EVIDENCE → analysisEligible follows v0.8 identity/material-change logic', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'FULL_EVIDENCE');

    // FULL_EVIDENCE + new_identity → analysisEligible = true (v0.8 behavior)
    expect(outcome.analysisEligible).toBe(true);
  });

  it('SEARCH_EVIDENCE candidate does NOT trigger MatchAnalysis via service', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    // evidenceLevel gate ensures analysisEligible=false
    expect(outcome.analysisEligible).toBe(false);
  });

  it('does not create RecommendationBatch rows', () => {
    const item = makeItem();
    service.ingest(item, 'SEARCH_EVIDENCE');

    const batchCount = (db.prepare('SELECT COUNT(*) AS cnt FROM radar_recommendation_batches').get() as { cnt: number }).cnt;
    expect(batchCount).toBe(0);
  });

  it('does not create MatchAnalysis rows', () => {
    const item = makeItem();
    service.ingest(item, 'SEARCH_EVIDENCE');

    const analysisCount = (db.prepare('SELECT COUNT(*) AS cnt FROM job_match_analysis_records').get() as { cnt: number }).cnt;
    expect(analysisCount).toBe(0);
  });

  it('inserts SourceRecord with provider=tavily', () => {
    const item = makeItem();
    const outcome = service.ingest(item, 'SEARCH_EVIDENCE');

    const repo = new RadarSourceRecordRepository(db);
    const source = repo.getById(outcome.sourceRecordId!);
    expect(source).not.toBeNull();
    expect(source!.providerKey).toBe('tavily');
    expect(source!.externalRecordId).toBe(item.url);
    expect(source!.sourceStatus).toBe('active');
  });
});
