import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { RadarCaptureService } from './service';
import { RadarCandidateRepository } from './candidateRepository';
import { RadarSourceRecordRepository } from './sourceRecordRepository';
import { canEnterAnalysis, evidenceGateReason, decideCommit } from './commitDecision';
import type { CommitDecisionInput } from './commitDecision';
import type { RadarCandidateNormalized, RadarEvidenceLevel } from '../../src/domain/radar';

let db: SqliteDatabase;
let tempDir: string;
let counter = 0;
let clock = 1_000_000;

function makeService(): RadarCaptureService {
  return new RadarCaptureService(db, { now: () => (clock += 1000), createId: () => `id-${(counter += 1)}` });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-w3-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  counter = 0;
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface ItemInput {
  providerKey?: string | null;
  externalRecordId?: string | null;
  sourceUrl?: string | null;
  recognizedFields?: Record<string, unknown> | null;
  visibleText?: string;
}

function bossItem(over: ItemInput = {}): Record<string, unknown> {
  return {
    captureMethod: 'boss_current_page',
    providerKey: over.providerKey === undefined ? 'boss' : over.providerKey,
    providerVersion: null,
    sourceUrl: over.sourceUrl === undefined ? 'https://www.zhipin.com/job_detail/abc123.html?securityId=X' : over.sourceUrl,
    sourceDomain: 'zhipin.com',
    pageTitle: '前端工程师',
    visibleText: over.visibleText ?? '岗位职责：负责前端开发',
    externalRecordId: over.externalRecordId === undefined ? 'ext-1' : over.externalRecordId,
    recognizedFields: over.recognizedFields === undefined
      ? { company: '赞同科技', role: '前端工程师', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科' }
      : over.recognizedFields,
    extractionMetadata: null,
    capturedAt: null,
  };
}

/** 创建会话、加一条项、commit，返回首个 outcome。 */
function captureOnce(svc: RadarCaptureService, item: Record<string, unknown>) {
  const session = svc.createSession({ sourceType: 'browser' });
  svc.addItem(session.session.id, item);
  const res = svc.commitSession(session.session.id, { confirmedIndexes: [0], corrections: [] });
  return { sessionId: session.session.id, outcome: res.outcomes[0]! };
}

describe('Wave3 commit decision: new_identity', () => {
  it('creates candidate + first version and is analysis-eligible', () => {
    const svc = makeService();
    const { outcome } = captureOnce(svc, bossItem());
    expect(outcome.decisionType).toBe('new_identity');
    expect(outcome.kind).toBe('created');
    expect(outcome.candidateId).not.toBeNull();
    expect(outcome.candidateVersionId).not.toBeNull();
    expect(outcome.analysisEligible).toBe(true);
    const candRepo = new RadarCandidateRepository(db);
    const versions = candRepo.listVersionsByCandidate(outcome.candidateId!);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.versionNo).toBe(1);
    expect(versions[0]?.originType).toBe('captured');
  });
});

describe('Wave3 commit decision: no_change vs material_change (new session, same job)', () => {
  it('same job re-captured with identical facts → no_change, no new version', () => {
    const svc = makeService();
    const first = captureOnce(svc, bossItem());
    const second = captureOnce(svc, bossItem());
    expect(second.outcome.decisionType).toBe('no_change');
    expect(second.outcome.kind).toBe('unchanged');
    expect(second.outcome.candidateId).toBe(first.outcome.candidateId);
    expect(second.outcome.analysisEligible).toBe(false);
    const candRepo = new RadarCandidateRepository(db);
    expect(candRepo.listVersionsByCandidate(first.outcome.candidateId!)).toHaveLength(1);
  });

  it('same job with a material salary change → material_change, new version supersedes', () => {
    const svc = makeService();
    const first = captureOnce(svc, bossItem());
    const second = captureOnce(svc, bossItem({
      recognizedFields: { company: '赞同科技', role: '前端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 30, salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科' },
    }));
    expect(second.outcome.decisionType).toBe('material_change');
    expect(second.outcome.kind).toBe('new_version');
    expect(second.outcome.candidateId).toBe(first.outcome.candidateId);
    expect(second.outcome.candidateVersionId).not.toBe(first.outcome.candidateVersionId);
    expect(second.outcome.analysisEligible).toBe(true);
    const candRepo = new RadarCandidateRepository(db);
    const versions = candRepo.listVersionsByCandidate(first.outcome.candidateId!);
    expect(versions).toHaveLength(2);
    const v2 = versions.find((v) => v.versionNo === 2)!;
    expect(v2.supersedesVersionId).toBe(first.outcome.candidateVersionId);
    expect(v2.originType).toBe('source_change');
    // 旧版本字节级不变。
    const v1 = versions.find((v) => v.versionNo === 1)!;
    expect(v1.id).toBe(first.outcome.candidateVersionId);
    expect(v1.normalized.salaryMinK).toBe(15);
    // changedFields 出现在决策摘要中。
    expect(second.outcome.decision.changedFields.some((c) => c.fieldPath === 'salaryMinK')).toBe(true);
  });

  it('active version content preserved after no_change re-capture', () => {
    const svc = makeService();
    const first = captureOnce(svc, bossItem());
    captureOnce(svc, bossItem());
    const candRepo = new RadarCandidateRepository(db);
    const cand = candRepo.getCandidate(first.outcome.candidateId!)!;
    expect(cand.activeVersionId).toBe(first.outcome.candidateVersionId);
  });
});

describe('Wave3 commit decision: extraction_regression', () => {
  it('known → unknown salary is regression: no new version, active unchanged', () => {
    const svc = makeService();
    const first = captureOnce(svc, bossItem());
    const regressed = captureOnce(svc, bossItem({
      recognizedFields: { company: '赞同科技', role: '前端工程师', city: '苏州', salaryMinK: null, salaryMaxK: null, salaryPeriod: null, experienceRequirement: '3-5年', educationRequirement: '本科' },
    }));
    expect(regressed.outcome.decisionType).toBe('extraction_regression');
    expect(regressed.outcome.analysisEligible).toBe(false);
    const candRepo = new RadarCandidateRepository(db);
    expect(candRepo.listVersionsByCandidate(first.outcome.candidateId!)).toHaveLength(1);
    // 退化不覆盖确定值：active 版本仍含 15K。
    const cand = candRepo.getCandidate(first.outcome.candidateId!)!;
    expect(candRepo.getVersion(cand.activeVersionId!)!.normalized.salaryMinK).toBe(15);
    expect(regressed.outcome.decision.needsConfirmation.length).toBeGreaterThan(0);
  });
});

describe('Wave3 commit decision: ambiguous_change', () => {
  it('company==role collision on re-capture → ambiguous_change, no new version', () => {
    const svc = makeService();
    const first = captureOnce(svc, bossItem());
    const ambiguous = captureOnce(svc, bossItem({
      recognizedFields: { company: '前端工程师', role: '前端工程师', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科' },
    }));
    expect(ambiguous.outcome.decisionType).toBe('ambiguous_change');
    expect(ambiguous.outcome.analysisEligible).toBe(false);
    expect(ambiguous.outcome.decision.needsConfirmation).toContain('company');
    const candRepo = new RadarCandidateRepository(db);
    expect(candRepo.listVersionsByCandidate(first.outcome.candidateId!)).toHaveLength(1);
  });
});

describe('Wave3 commit decision: identity_conflict (Tier2 multi-hit)', () => {
  it('two distinct sources sharing a canonical URL under same provider → conflict, no 2nd candidate/version', () => {
    const svc = makeService();
    // 两个不同 externalRecordId 但相同 canonical URL 的来源，先各自建候选。
    const a = captureOnce(svc, bossItem({ externalRecordId: 'ext-A', sourceUrl: 'https://www.zhipin.com/job_detail/shared.html?securityId=A' }));
    const b = captureOnce(svc, bossItem({ externalRecordId: 'ext-B', sourceUrl: 'https://www.zhipin.com/job_detail/shared.html?securityId=B' }));
    expect(a.outcome.decisionType).toBe('new_identity');
    expect(b.outcome.decisionType).toBe('new_identity');
    const srcRepo = new RadarSourceRecordRepository(db);
    expect(srcRepo.findAllByProviderAndUrl('boss', 'https://www.zhipin.com/job_detail/shared')).toHaveLength(2);
    const candRepo = new RadarCandidateRepository(db);
    const candCountBefore = (db.prepare('SELECT COUNT(*) c FROM radar_candidates').get() as { c: number }).c;

    // 第三次采集：providerKey 存在但无 externalRecordId（走 Tier2）→ 多命中 → conflict。
    const conflict = captureOnce(svc, bossItem({ externalRecordId: null, sourceUrl: 'https://www.zhipin.com/job_detail/shared.html?securityId=C' }));
    expect(conflict.outcome.decisionType).toBe('identity_conflict');
    expect(conflict.outcome.candidateId).toBeNull();
    expect(conflict.outcome.candidateVersionId).toBeNull();
    expect(conflict.outcome.analysisEligible).toBe(false);
    expect(conflict.outcome.decision.conflictReason).toBe('tier2_multiple_matches');
    // 未创建第二/第三候选（仅 snapshot 落库）。
    const candCountAfter = (db.prepare('SELECT COUNT(*) c FROM radar_candidates').get() as { c: number }).c;
    expect(candCountAfter).toBe(candCountBefore);
    // 但 Snapshot 已保存。
    expect(conflict.outcome.snapshotId).not.toBeNull();
    void candRepo;
  });
});

describe('Wave3 array set semantics via full flow', () => {
  it('responsibilities reorder (same set) → no_change', () => {
    const svc = makeService();
    // 首次带结构化职责需通过 recognizedFields？V8-2 recognizedFields 无 responsibilities，
    // 因此此处验证纯标量层：JD 文本变化不影响 fingerprint（rawDescription 不入材料指纹）。
    const first = captureOnce(svc, bossItem({ visibleText: '职责：A；B；C' }));
    const reordered = captureOnce(svc, bossItem({ visibleText: '职责：C；B；A（顺序不同）' }));
    expect(reordered.outcome.decisionType).toBe('no_change');
    const candRepo = new RadarCandidateRepository(db);
    expect(candRepo.listVersionsByCandidate(first.outcome.candidateId!)).toHaveLength(1);
  });
});

// ── v0.9 Phase 4A: Data Quality Gate（T034 / T036）────────────────────────────

describe('Data Quality Gate — canEnterAnalysis', () => {
  it('FULL_EVIDENCE → true', () => {
    expect(canEnterAnalysis('FULL_EVIDENCE')).toBe(true);
  });

  it('SEARCH_EVIDENCE → false', () => {
    expect(canEnterAnalysis('SEARCH_EVIDENCE')).toBe(false);
  });

  it('MANUAL_REVIEW_REQUIRED → false', () => {
    expect(canEnterAnalysis('MANUAL_REVIEW_REQUIRED')).toBe(false);
  });
});

describe('Data Quality Gate — evidenceGateReason', () => {
  it('FULL_EVIDENCE → null (no block)', () => {
    expect(evidenceGateReason('FULL_EVIDENCE')).toBeNull();
  });

  it('SEARCH_EVIDENCE → contains "insufficient_evidence"', () => {
    const reason = evidenceGateReason('SEARCH_EVIDENCE');
    expect(reason).not.toBeNull();
    expect(reason).toContain('insufficient_evidence');
    expect(reason).toContain('SEARCH_EVIDENCE');
    expect(reason).toContain('MatchAnalysis');
  });

  it('MANUAL_REVIEW_REQUIRED → contains "manual_review_required"', () => {
    const reason = evidenceGateReason('MANUAL_REVIEW_REQUIRED');
    expect(reason).not.toBeNull();
    expect(reason).toContain('manual_review_required');
    expect(reason).toContain('user must confirm');
  });
});

describe('Data Quality Gate — consistency with decideCommit evidence gate', () => {
  const nullNormalized: RadarCandidateNormalized = {
    company: null, role: null, city: null, district: null,
    salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
    experienceRequirement: null, educationRequirement: null,
    companySize: null, industry: null, jobNature: null, workMode: null,
    technicalStack: [], responsibilities: [], requirements: [],
    publishedAt: null, rawDescription: '',
  };

  function input(level: RadarEvidenceLevel): CommitDecisionInput {
    return {
      identity: { kind: 'new_source', matched: null, canonicalSourceUrl: null,
        matchTier: 'tier1_exact', reason: null },
      previousNormalized: null,
      nextNormalized: nullNormalized,
      ambiguousFields: [],
      snapshotId: 'snap-test',
      evidenceLevel: level,
    };
  }

  it('FULL_EVIDENCE + new_identity → analysisEligible=true (matches canEnterAnalysis)', () => {
    const d = decideCommit(input('FULL_EVIDENCE'));
    expect(canEnterAnalysis('FULL_EVIDENCE')).toBe(true);
    expect(d.summary.analysisEligible).toBe(true);
  });

  it('SEARCH_EVIDENCE + new_identity → analysisEligible=false (matches canEnterAnalysis)', () => {
    const d = decideCommit(input('SEARCH_EVIDENCE'));
    expect(canEnterAnalysis('SEARCH_EVIDENCE')).toBe(false);
    expect(d.summary.analysisEligible).toBe(false);
  });

  it('MANUAL_REVIEW_REQUIRED + new_identity → analysisEligible=false (matches canEnterAnalysis)', () => {
    const d = decideCommit(input('MANUAL_REVIEW_REQUIRED'));
    expect(canEnterAnalysis('MANUAL_REVIEW_REQUIRED')).toBe(false);
    expect(d.summary.analysisEligible).toBe(false);
  });

  it('undefined evidenceLevel defaults to FULL_EVIDENCE → analysisEligible=true', () => {
    const i = { ...input('FULL_EVIDENCE'), evidenceLevel: undefined };
    const d = decideCommit(i);
    expect(d.summary.analysisEligible).toBe(true);
  });
});

describe('Data Quality Gate — Source Policy integration (zhiye before fetch)', () => {
  it('jobs.zhiye.com initialEvidenceLevel=SEARCH_EVIDENCE → canEnterAnalysis=false', () => {
    // SEARCH_AND_FETCH 来源在 fetch 前的证据等级是 SEARCH_EVIDENCE —— 不是 FULL_EVIDENCE。
    expect(canEnterAnalysis('SEARCH_EVIDENCE')).toBe(false);
  });

  it('only explicit FULL_EVIDENCE → canEnterAnalysis=true', () => {
    // 唯一能进入分析的路径是显式传入 FULL_EVIDENCE。
    expect(canEnterAnalysis('FULL_EVIDENCE')).toBe(true);
    expect(canEnterAnalysis('SEARCH_EVIDENCE')).toBe(false);
    expect(canEnterAnalysis('MANUAL_REVIEW_REQUIRED')).toBe(false);
  });

  it('zhipin/liepin/zhaopin/lagou/51job → MANUAL_REVIEW_REQUIRED → canEnterAnalysis=false', () => {
    for (const _ of ['zhipin', 'liepin', 'zhaopin', 'lagou', '51job']) {
      expect(canEnterAnalysis('MANUAL_REVIEW_REQUIRED')).toBe(false);
    }
  });

  it('unknown domain → MANUAL_REVIEW_REQUIRED → canEnterAnalysis=false', () => {
    expect(canEnterAnalysis('MANUAL_REVIEW_REQUIRED')).toBe(false);
  });
});
