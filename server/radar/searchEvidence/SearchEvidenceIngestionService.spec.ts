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

  describe('Historical Version Reactivation（Bug A）', () => {
  const url = 'https://www.zhipin.com/job_detail/reactivation-test.html';

  it('active=A → incoming=A → no_change，不创建新版本', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const first = service.ingest(itemA, 'SEARCH_EVIDENCE');
    const second = service.ingest(itemA, 'SEARCH_EVIDENCE');

    expect(second.decisionType).toBe('no_change');
    expect(second.candidateVersionId).toBe(first.candidateVersionId);

    const repo = new RadarCandidateRepository(db);
    expect(repo.listVersionsByCandidate(first.candidateId!)).toHaveLength(1);
  });

  it('active=A → incoming=B（历史无 B）→ 创建 B，active=B', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const itemB = makeItem({ url, title: '后端开发工程师' });
    const a = service.ingest(itemA, 'SEARCH_EVIDENCE');
    const b = service.ingest(itemB, 'SEARCH_EVIDENCE');

    expect(b.decisionType).toBe('material_change');
    expect(b.candidateVersionId).not.toBe(a.candidateVersionId);

    const repo = new RadarCandidateRepository(db);
    expect(repo.listVersionsByCandidate(a.candidateId!)).toHaveLength(2);
    expect(repo.getCandidate(a.candidateId!)!.activeVersionId).toBe(b.candidateVersionId);
  });

  it('history=A, active=B → incoming=A → 复用历史 A，active=A，不创建重复版本', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const itemB = makeItem({ url, title: '后端开发工程师' });
    const a = service.ingest(itemA, 'SEARCH_EVIDENCE');
    service.ingest(itemB, 'SEARCH_EVIDENCE');
    const aAgain = service.ingest(itemA, 'SEARCH_EVIDENCE');

    // active 从 B 变回 A：是 material_change，不是 no_change。
    expect(aAgain.decisionType).toBe('material_change');
    // 复用历史 A，而不是新建第三个版本。
    expect(aAgain.candidateVersionId).toBe(a.candidateVersionId);

    const repo = new RadarCandidateRepository(db);
    const versions = repo.listVersionsByCandidate(a.candidateId!);
    expect(versions).toHaveLength(2);
    expect(repo.getCandidate(a.candidateId!)!.activeVersionId).toBe(a.candidateVersionId);
  });

  it('A→B→A→B→A 反复震荡只保留 A、B 两个 unique content hash', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const itemB = makeItem({ url, title: '后端开发工程师' });

    service.ingest(itemA, 'SEARCH_EVIDENCE'); // A
    service.ingest(itemB, 'SEARCH_EVIDENCE'); // B
    const third = service.ingest(itemA, 'SEARCH_EVIDENCE'); // A（复用）
    service.ingest(itemB, 'SEARCH_EVIDENCE'); // B（复用）
    const fifth = service.ingest(itemA, 'SEARCH_EVIDENCE'); // A（复用）

    const repo = new RadarCandidateRepository(db);
    const versions = repo.listVersionsByCandidate(third.candidateId!);
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((v) => v.contentHash)).size).toBe(2);
    expect(repo.getCandidate(third.candidateId!)!.activeVersionId).toBe(fifth.candidateVersionId);
  });

  it('历史回退不触发 UNIQUE(candidate_id, content_hash)，摄入正常返回', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const itemB = makeItem({ url, title: '后端开发工程师' });
    service.ingest(itemA, 'SEARCH_EVIDENCE');
    service.ingest(itemB, 'SEARCH_EVIDENCE');

    // 第三次回到 A：不应抛 SQLITE_CONSTRAINT_UNIQUE。
    expect(() => service.ingest(itemA, 'SEARCH_EVIDENCE')).not.toThrow();
  });

  it('回退时当前 observation snapshot 仍正常持久化', () => {
    const itemA = makeItem({ url, title: '前端开发工程师' });
    const itemB = makeItem({ url, title: '后端开发工程师' });
    service.ingest(itemA, 'SEARCH_EVIDENCE');
    service.ingest(itemB, 'SEARCH_EVIDENCE');
    const aAgain = service.ingest(itemA, 'SEARCH_EVIDENCE');

    const snapshot = new RadarCaptureRepository(db).getSnapshot(aAgain.snapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.captureMethod).toBe('search_discovery');
  });
  });
});

describe('P0.1 — evidence-state reactivation（同材料 + 证据状态变化）', () => {
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

  it('historical MRR + current SEARCH_EVIDENCE + same material → 不倒退为 MRR（active 提升为 SEARCH 版本）', () => {
    const item = makeItem({ url: 'https://acme.com/jobs/ev1' });
    const first = service.ingest(item, 'MANUAL_REVIEW_REQUIRED');
    const second = service.ingest(item, 'SEARCH_EVIDENCE');

    const repo = new RadarCandidateRepository(db);
    const cand = repo.getCandidate(first.candidateId!);
    expect(second.candidateId).toBe(first.candidateId);
    // 不得 reactivate 旧 MRR 版本：active 必须是 SEARCH_EVIDENCE 版本
    expect(cand!.activeVersionId).not.toBe(first.candidateVersionId);
    const active = repo.getVersion(cand!.activeVersionId!);
    expect(active!.evidenceLevel).toBe('SEARCH_EVIDENCE');
    // 同材料但 evidence 维度不同 → contentHash 不同
    const firstVersion = repo.getVersion(first.candidateVersionId!);
    expect(active!.contentHash).not.toBe(firstVersion!.contentHash);
    // 新版本 versionNo 递增
    expect(active!.versionNo).toBeGreaterThan(firstVersion!.versionNo);
  });

  it('historical SEARCH + current SEARCH + same content → reactivation 幂等（不创建重复版本）', () => {
    const item = makeItem({ url: 'https://acme.com/jobs/ev2' });
    const first = service.ingest(item, 'SEARCH_EVIDENCE');
    const second = service.ingest(item, 'SEARCH_EVIDENCE');

    const repo = new RadarCandidateRepository(db);
    expect(second.candidateVersionId).toBe(first.candidateVersionId);
    expect(repo.listVersionsByCandidate(first.candidateId!)).toHaveLength(1);
    expect(repo.getCandidate(first.candidateId!)!.activeVersionId).toBe(first.candidateVersionId);
  });

  it('historical MRR + current MRR + same content → reactivation 幂等（同 evidence）', () => {
    const item = makeItem({ url: 'https://acme.com/jobs/ev5' });
    const first = service.ingest(item, 'MANUAL_REVIEW_REQUIRED');
    const second = service.ingest(item, 'MANUAL_REVIEW_REQUIRED');

    expect(second.candidateVersionId).toBe(first.candidateVersionId);
    expect(new RadarCandidateRepository(db).listVersionsByCandidate(first.candidateId!)).toHaveLength(1);
  });

  it('material 真正变化 → 创建新版本并 active（evidence 单调性不挡材料变化）', () => {
    const itemA = makeItem({ url: 'https://acme.com/jobs/ev3', title: '前端工程师' });
    const first = service.ingest(itemA, 'SEARCH_EVIDENCE');
    const itemB = makeItem({ url: 'https://acme.com/jobs/ev3', title: '高级前端工程师' });
    const second = service.ingest(itemB, 'SEARCH_EVIDENCE');

    const repo = new RadarCandidateRepository(db);
    expect(second.candidateVersionId).not.toBe(first.candidateVersionId);
    const cand = repo.getCandidate(first.candidateId!);
    expect(cand!.activeVersionId).toBe(second.candidateVersionId);
    expect(repo.getVersion(cand!.activeVersionId!)!.evidenceLevel).toBe('SEARCH_EVIDENCE');
  });

  it('existing FULL_EVIDENCE 不被降级（同材料 + SEARCH 摄入保持 FULL active）', () => {
    const item = makeItem({ url: 'https://acme.com/jobs/ev4' });
    const first = service.ingest(item, 'FULL_EVIDENCE');
    const second = service.ingest(item, 'SEARCH_EVIDENCE');

    const repo = new RadarCandidateRepository(db);
    expect(second.candidateVersionId).toBe(first.candidateVersionId);
    expect(repo.listVersionsByCandidate(first.candidateId!)).toHaveLength(1);
    expect(repo.getCandidate(first.candidateId!)!.activeVersionId).toBe(first.candidateVersionId);
    expect(repo.getVersion(first.candidateVersionId!)!.evidenceLevel).toBe('FULL_EVIDENCE');
  });
});
