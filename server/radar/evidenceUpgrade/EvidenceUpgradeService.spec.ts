/**
 * v0.9 Phase 5A — Evidence Upgrade Persistence Service 测试。
 *
 * 覆盖：
 *   - 前置校验（validation / source evidenceLevel / Source Policy / stale / candidate）
 *   - 首次 upgrade 语义（evidence_upgrade + FULL_EVIDENCE + supersedesVersionId + 继承）
 *   - 幂等 / stale 顺序（same source same/changed content、true stale、different source same content）
 *   - 并发不变量（same-content UNIQUE 兜底、same-source different-content 单 child）
 *   - snapshot 有界 metadata（不持久化 raw HTML / raw_content）
 *
 * 注意：better-sqlite3 为单连接同步执行，「并发」以顺序调用模拟——顺序调用下不变量成立，
 * 正是 BEGIN IMMEDIATE 串行化在真实并发下也能成立的同源机制（见 Delivery Report）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { EvidenceUpgradeService } from './EvidenceUpgradeService';
import type { EvidenceUpgradeInput } from './types';
import type { EvidenceValidationResult, ExtractedContent } from '../../content-acquisition/types';
import { SearchEvidenceIngestionService } from '../searchEvidence/SearchEvidenceIngestionService';
import type { SearchEvidenceItem } from '../searchEvidence/searchEvidenceTypes';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureRepository } from '../captureRepository';
import { normalizeSourceUrl } from '../normalize';
import { computeCandidateFingerprint } from '../candidateFingerprint';
import { sha256RequestHash } from '../../job-memory/requestHash';
import type {
  RadarCandidate,
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarCaptureSnapshot,
  RadarEvidenceLevel,
} from '../../../src/domain/radar';
import { DAILY_JOB_HUNTER_SCHEMA_VERSION, runMigrations } from '../../migrations';
import { openDb } from '../../db';

const FULL_TEXT = '负责Web前端开发，使用React与TypeScript。岗位职责包括页面开发、组件封装与性能优化，'
  + '以及配合后端完成接口联调。任职要求3年以上经验，本科及以上学历，熟悉前端工程化与代码规范。';

function makeSearchItem(overrides: Partial<SearchEvidenceItem> = {}): SearchEvidenceItem {
  return {
    provider: 'tavily',
    query: '苏州 前端工程师 招聘',
    providerRequestId: `req-${randomUUID().slice(0, 8)}`,
    title: '高级前端开发工程师',
    url: `https://jobs.zhiye.com/jobs/${randomUUID().slice(0, 8)}`,
    content: '负责Web前端开发，使用React。',
    domain: 'jobs.zhiye.com',
    providerScore: 0.85,
    publishedAt: '2026-08-01',
    searchedAt: Date.now(),
    providerMetadata: {},
    ...overrides,
  };
}

function makeContent(overrides: Partial<ExtractedContent> = {}): ExtractedContent {
  return {
    title: '高级前端开发工程师',
    plainText: FULL_TEXT,
    canonicalUrl: 'https://jobs.zhiye.com/jobs/canonical',
    contentType: 'text/html',
    ...overrides,
  };
}

function makeValidation(status: 'PASS' | 'FAIL' = 'PASS'): EvidenceValidationResult {
  return status === 'PASS'
    ? { status: 'PASS', reasonCode: 'jd_complete' }
    : { status: 'FAIL', reasonCode: 'insufficient_content' };
}

function makeInput(sourceVersionId: string, overrides: Partial<EvidenceUpgradeInput> = {}): EvidenceUpgradeInput {
  return {
    sourceVersionId,
    content: makeContent(),
    validation: makeValidation(),
    ...overrides,
  };
}

describe('EvidenceUpgradeService', () => {
  let db: Database.Database;
  let now: number;
  let createId: () => string;
  let searchIngest: SearchEvidenceIngestionService;
  let service: EvidenceUpgradeService;
  let candidates: RadarCandidateRepository;
  let captures: RadarCaptureRepository;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db, { targetVersion: DAILY_JOB_HUNTER_SCHEMA_VERSION });
    now = Date.now();
    createId = randomUUID;
    searchIngest = new SearchEvidenceIngestionService(db, { now: () => now, createId });
    service = new EvidenceUpgradeService(db, { now: () => now, createId });
    candidates = new RadarCandidateRepository(db);
    captures = new RadarCaptureRepository(db);
  });

  /** 摄入一条 SEARCH_EVIDENCE 来源，返回其 sourceVersionId。 */
  function ingestSource(item: SearchEvidenceItem, evidenceLevel: RadarEvidenceLevel = 'SEARCH_EVIDENCE'): {
    versionId: string;
    candidateId: string;
  } {
    const outcome = searchIngest.ingest(item, evidenceLevel);
    return { versionId: outcome.candidateVersionId!, candidateId: outcome.candidateId! };
  }

  function version(id: string): RadarCandidateVersion {
    const v = candidates.getVersion(id);
    expect(v).not.toBeNull();
    return v!;
  }

  /**
   * 在既有 candidate 上手工落一个 SEARCH_EVIDENCE 版本（模拟不同 sourceVersion，用于 candidate-level 去重）。
   *
   * contentHash 可覆盖：真实生产里「不同 sourceVersion」意味着 structured facts 不同、material fingerprint 也不同；
   * 但 candidate-level same-content 分支要求两来源的最终完整内容字节一致（继承模型下即 structured facts 相同），
   * 这与「material fingerprint 相同 → UNIQUE(candidate_id, content_hash) 冲突」天然矛盾。
   * 因此该分支是防御性（UNIQUE race 的前置对偶），测试用区分来源的 contentHash 单独触发它。
   */
  function insertSearchVersion(
    candidate: RadarCandidate,
    normalized: RadarCandidateNormalized,
    sourceUrl: string,
    contentHash = computeCandidateFingerprint(normalized),
  ): string {
    const snapshot: RadarCaptureSnapshot = {
      id: createId(),
      captureSessionId: null,
      captureMethod: 'search_discovery',
      providerKey: 'tavily',
      providerVersion: null,
      sourceDomain: new URL(sourceUrl).hostname,
      sourceUrl,
      normalizedSourceUrl: normalizeSourceUrl(sourceUrl),
      externalRecordId: sourceUrl,
      pageTitle: normalized.role ?? 'title',
      visibleText: normalized.rawDescription,
      rawSnapshot: { provider: 'tavily' },
      rawContentHash: sha256RequestHash({
        captureMethod: 'search_discovery',
        sourceUrl: normalizeSourceUrl(sourceUrl),
        visibleText: normalized.rawDescription,
      }),
      capturedAt: now,
      createdAt: now,
    };
    captures.insertSnapshot(snapshot);
    const v: RadarCandidateVersion = {
      id: createId(),
      candidateId: candidate.id,
      versionNo: candidates.nextVersionNo(candidate.id),
      normalized,
      qualityIssues: [],
      sourceSnapshotIds: [snapshot.id],
      contentHash,
      originType: 'captured',
      evidenceLevel: 'SEARCH_EVIDENCE',
      correctionNote: null,
      supersedesVersionId: candidate.activeVersionId,
      createdAt: now,
    };
    candidates.insertVersion(v);
    candidates.setActiveVersionId(candidate.id, v.id, now);
    return v.id;
  }

  // ── 前置校验 ────────────────────────────────────────────────────────────────

  it('validation FAIL → BLOCKED validation_not_eligible', () => {
    const { versionId } = ingestSource(makeSearchItem());
    const result = service.upgrade(makeInput(versionId, { validation: makeValidation('FAIL') }));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'validation_not_eligible' });
  });

  it('source version 不存在 → BLOCKED source_version_not_found', () => {
    const result = service.upgrade(makeInput('missing-version'));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'source_version_not_found' });
  });

  it('MANUAL_REVIEW_REQUIRED source → BLOCKED invalid_source_evidence_level', () => {
    const { versionId } = ingestSource(makeSearchItem(), 'MANUAL_REVIEW_REQUIRED');
    const result = service.upgrade(makeInput(versionId));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'invalid_source_evidence_level' });
  });

  it('FULL_EVIDENCE source → BLOCKED invalid_source_evidence_level', () => {
    const { versionId } = ingestSource(makeSearchItem(), 'FULL_EVIDENCE');
    const result = service.upgrade(makeInput(versionId));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'invalid_source_evidence_level' });
  });

  it('CONDITIONAL_FETCH (juejin.cn) SEARCH_EVIDENCE + 伪造 PASS → BLOCKED source_policy_blocked', () => {
    const { versionId } = ingestSource(makeSearchItem({
      url: `https://juejin.cn/post/${randomUUID().slice(0, 8)}`,
      domain: 'juejin.cn',
    }));
    const result = service.upgrade(makeInput(versionId, { validation: makeValidation('PASS') }));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'source_policy_blocked' });
  });

  it('archived candidate → BLOCKED candidate_not_active', () => {
    const { candidateId, versionId } = ingestSource(makeSearchItem());
    candidates.setLifecycleStatus(candidateId, 'archived', null, now);
    const result = service.upgrade(makeInput(versionId));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'candidate_not_active' });
  });

  // ── 首次 upgrade 语义 ────────────────────────────────────────────────────────

  it('首次 SEARCH_EVIDENCE + PASS → UPGRADED，创建 evidence_upgrade + FULL_EVIDENCE 版本', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());
    const result = service.upgrade(makeInput(versionId));

    expect(result.status).toBe('UPGRADED');
    const v = version((result as { versionId: string }).versionId);
    expect(v.candidateId).toBe(candidateId);
    expect(v.originType).toBe('evidence_upgrade');
    expect(v.evidenceLevel).toBe('FULL_EVIDENCE');
    expect(v.supersedesVersionId).toBe(versionId);
  });

  it('原 SEARCH_EVIDENCE 版本不变，candidate identity 不变', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());
    const sourceBefore = version(versionId);
    const result = service.upgrade(makeInput(versionId));

    expect(result.status).toBe('UPGRADED');
    const sourceAfter = version(versionId);
    expect(sourceAfter).toEqual(sourceBefore);
    expect(sourceAfter.evidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(sourceAfter.originType).toBe('captured');
    // candidate 数量仍为 1（未新建 candidate）
    expect(candidates.listActiveCandidates()).toHaveLength(1);
    expect(sourceAfter.candidateId).toBe(candidateId);
  });

  it('structured facts 全继承，rawDescription = full plainText，content.title 不覆盖 role', () => {
    const item = makeSearchItem();
    const { versionId } = ingestSource(item);
    const source = version(versionId);

    const result = service.upgrade(makeInput(versionId, {
      content: makeContent({ title: 'DIFFERENT TITLE' }),
    }));
    expect(result.status).toBe('UPGRADED');
    const v = version((result as { versionId: string }).versionId);

    expect(v.normalized.role).toBe(source.normalized.role); // content.title 未覆盖 role
    expect(v.normalized.role).toBe(item.title);
    expect(v.normalized.company).toBe(source.normalized.company);
    expect(v.normalized.city).toBe(source.normalized.city);
    expect(v.normalized.rawDescription).toBe(FULL_TEXT);
  });

  it('material fingerprint 可不变但 upgrade contentHash 改变（rawDescription 升级）', () => {
    const { versionId } = ingestSource(makeSearchItem());
    const source = version(versionId);

    const result = service.upgrade(makeInput(versionId));
    expect(result.status).toBe('UPGRADED');
    const v = version((result as { versionId: string }).versionId);

    expect(computeCandidateFingerprint(source.normalized)).toBe(computeCandidateFingerprint(v.normalized));
    expect(source.contentHash).not.toBe(v.contentHash);
  });

  it('open_web_fetch snapshot 有界 metadata，不持久化 raw HTML / raw_content', () => {
    const { versionId } = ingestSource(makeSearchItem());
    const result = service.upgrade(makeInput(versionId, {
      content: makeContent({ canonicalUrl: 'https://jobs.zhiye.com/jobs/c', contentType: 'text/html' }),
    }));

    expect(result.status).toBe('UPGRADED');
    const snapshot = captures.getSnapshot((result as { snapshotId: string }).snapshotId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.captureMethod).toBe('open_web_fetch');
    expect(snapshot!.pageTitle).toBe('高级前端开发工程师');
    expect(snapshot!.visibleText).toBe(FULL_TEXT);
    expect(snapshot!.providerKey).toBe('tavily');
    expect(snapshot!.providerVersion).toBeNull();

    const raw = snapshot!.rawSnapshot as Record<string, unknown>;
    expect(raw).toEqual({ canonicalUrl: 'https://jobs.zhiye.com/jobs/c', contentType: 'text/html' });
    expect(raw).not.toHaveProperty('rawHtml');
    expect(raw).not.toHaveProperty('raw_content');
    expect(raw).not.toHaveProperty('html');
  });

  it('providerVersion Reality Check：source search_discovery snapshot.providerVersion 恒为 null（Answer A）', () => {
    const { versionId } = ingestSource(makeSearchItem());
    const source = version(versionId);
    const sourceSnapshot = captures.getSnapshot(source.sourceSnapshotIds[0]);
    expect(sourceSnapshot).not.toBeNull();
    // 当前真实 source metadata：providerKey 有值、providerVersion 恒为 null（SearchEvidenceItem 无该字段）
    expect(sourceSnapshot!.captureMethod).toBe('search_discovery');
    expect(sourceSnapshot!.providerKey).toBe('tavily');
    expect(sourceSnapshot!.providerVersion).toBeNull();
  });

  it('snapshot association：新 FULL_EVIDENCE 版本关联 open_web_fetch snapshot，源版本仍关联 search_discovery', () => {
    const { versionId } = ingestSource(makeSearchItem());
    const source = version(versionId);

    const result = service.upgrade(makeInput(versionId));
    expect(result.status).toBe('UPGRADED');
    const upgraded = version((result as { versionId: string }).versionId);
    const newSnapshot = captures.getSnapshot((result as { snapshotId: string }).snapshotId);

    // 新版本 sourceSnapshotIds 指向本轮 open_web_fetch snapshot
    expect(upgraded.sourceSnapshotIds).toEqual([newSnapshot!.id]);
    expect(newSnapshot!.captureMethod).toBe('open_web_fetch');

    // 源 SEARCH_EVIDENCE 版本仍关联原 search_discovery snapshot
    const sourceSnapshot = captures.getSnapshot(source.sourceSnapshotIds[0]);
    expect(sourceSnapshot!.captureMethod).toBe('search_discovery');
    expect(source.sourceSnapshotIds).not.toContain(newSnapshot!.id);
  });

  // ── 幂等 / stale 顺序 ───────────────────────────────────────────────────────

  it('same source + same content → 第二次 ALREADY_UPGRADED（不是 stale），不改 activeVersionId', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());
    const first = service.upgrade(makeInput(versionId));
    expect(first.status).toBe('UPGRADED');
    const upgradedId = (first as { versionId: string }).versionId;

    const second = service.upgrade(makeInput(versionId));
    expect(second).toEqual({ status: 'ALREADY_UPGRADED', existingVersionId: upgradedId, candidateId });

    // 零写入：active 仍是首次升级版本，版本数不变
    expect(candidates.getCandidate(candidateId)!.activeVersionId).toBe(upgradedId);
    expect(candidates.listVersionsByCandidate(candidateId)).toHaveLength(2);
  });

  it('same source + changed content → BLOCKED source_already_upgraded_content_changed，零写入', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());
    const first = service.upgrade(makeInput(versionId));
    expect(first.status).toBe('UPGRADED');

    const second = service.upgrade(makeInput(versionId, {
      content: makeContent({ plainText: FULL_TEXT + ' 追加的新内容。' }),
    }));
    expect(second).toEqual({ status: 'BLOCKED', reasonCode: 'source_already_upgraded_content_changed' });

    // 仍只有一个 evidence_upgrade child
    const children = candidates.listVersionsByCandidate(candidateId)
      .filter((v) => v.originType === 'evidence_upgrade');
    expect(children).toHaveLength(1);
  });

  it('true stale → BLOCKED stale_source_version（V1 已非 active 且无 child）', () => {
    const itemA = makeSearchItem();
    const { versionId: v1 } = ingestSource(itemA);
    // 同一 URL 的第二次搜索（role 变化 → material_change → V2 成为 active）
    ingestSource(makeSearchItem({ url: itemA.url, title: '资深前端工程师', content: '负责前端架构设计。' }));

    const result = service.upgrade(makeInput(v1));
    expect(result).toEqual({ status: 'BLOCKED', reasonCode: 'stale_source_version' });
  });

  it('different source + same final content → ALREADY_UPGRADED 指向既有 V2，零写入', () => {
    const item = makeSearchItem();
    const { versionId: v1, candidateId } = ingestSource(item);
    const sourceNormalized = version(v1).normalized;

    // V1 → V2 (FULL_EVIDENCE evidence_upgrade)
    const first = service.upgrade(makeInput(v1));
    expect(first.status).toBe('UPGRADED');
    const v2 = (first as { versionId: string }).versionId;

    // 手工落 V3（不同 sourceVersion，同 structured facts），使其成为 active。
    // contentHash 用区分来源的值避免与 V1 的 material fingerprint 撞 UNIQUE（见 insertSearchVersion 注释）。
    const v3 = insertSearchVersion(
      candidates.getCandidate(candidateId)!,
      sourceNormalized,
      item.url,
      `different-source:${computeCandidateFingerprint(sourceNormalized)}`,
    );

    // 对 V3 采集得到与 V2 完全相同的 final content → candidate-level 命中 V2
    const result = service.upgrade(makeInput(v3));
    expect(result).toEqual({ status: 'ALREADY_UPGRADED', existingVersionId: v2, candidateId });

    // 零写入：V3 仍是 active，未新建版本
    expect(candidates.getCandidate(candidateId)!.activeVersionId).toBe(v3);
    expect(candidates.listVersionsByCandidate(candidateId)).toHaveLength(3);
  });

  // ── 并发不变量 ──────────────────────────────────────────────────────────────

  it('concurrent same-content（顺序模拟）→ 一次 UPGRADED + 一次 ALREADY_UPGRADED，单 child', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());

    const outcomes = [
      service.upgrade(makeInput(versionId)),
      service.upgrade(makeInput(versionId)),
    ];
    const statuses = outcomes.map((o) => o.status).sort();
    expect(statuses).toEqual(['ALREADY_UPGRADED', 'UPGRADED']);

    const children = candidates.listVersionsByCandidate(candidateId)
      .filter((v) => v.originType === 'evidence_upgrade');
    expect(children).toHaveLength(1);
  });

  it('concurrent same-source different-content（顺序模拟）→ 最多一个 evidence_upgrade child', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());

    const a = service.upgrade(makeInput(versionId, { content: makeContent({ plainText: FULL_TEXT }) }));
    const b = service.upgrade(makeInput(versionId, { content: makeContent({ plainText: FULL_TEXT + ' 不同正文B' }) }));

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['BLOCKED', 'UPGRADED']);
    const blocked = [a, b].find((r) => r.status === 'BLOCKED');
    expect(blocked).toEqual({ status: 'BLOCKED', reasonCode: 'source_already_upgraded_content_changed' });

    const children = candidates.listVersionsByCandidate(candidateId)
      .filter((v) => v.originType === 'evidence_upgrade');
    expect(children).toHaveLength(1);
  });

  it('不产生 duplicate candidate，且 source record 的 latestSnapshot 指向 open_web_fetch snapshot', () => {
    const { versionId, candidateId } = ingestSource(makeSearchItem());
    const result = service.upgrade(makeInput(versionId));
    expect(result.status).toBe('UPGRADED');
    expect(candidates.listActiveCandidates()).toHaveLength(1);
    expect(candidates.getCandidate(candidateId)!.activeVersionId).toBe((result as { versionId: string }).versionId);
  });
});
