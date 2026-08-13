import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { RadarCaptureService } from './service';
import { RadarCandidateRepository } from './candidateRepository';
import { RadarActionRepository } from './actionRepository';
import { RadarCandidateRelationRepository, normalizeCandidatePair } from './candidateRelationRepository';
import { RadarDuplicateAdjudicationService } from './duplicateAdjudicationService';

let db: SqliteDatabase;
let tempDir: string;
let counter = 0;
let clock = 2_000_000;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-w4-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  counter = 0;
  clock = 2_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deps() {
  return { now: () => (clock += 1000), createId: () => `id-${(counter += 1)}` };
}

/** 通过真实 capture flow 建两个独立候选，返回其 id。 */
function makeTwoCandidates(): { a: string; b: string } {
  const svc = new RadarCaptureService(db, deps());
  const mk = (ext: string, company: string) => {
    const s = svc.createSession({ sourceType: 'browser' });
    svc.addItem(s.session.id, {
      captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
      sourceUrl: `https://www.zhipin.com/job_detail/${ext}.html`, sourceDomain: 'zhipin.com',
      pageTitle: null, visibleText: 'jd', externalRecordId: ext,
      recognizedFields: { company, role: '前端', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月', experienceRequirement: null, educationRequirement: null },
      extractionMetadata: null, capturedAt: null,
    });
    const res = svc.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] });
    return res.outcomes[0]!.candidateId!;
  };
  return { a: mk('job-a', 'A公司'), b: mk('job-b', 'B公司') };
}

describe('candidate pair normalization', () => {
  it('(A,B) and (B,A) normalize to the same [low,high]', () => {
    expect(normalizeCandidatePair('x', 'y')).toEqual({ low: 'x', high: 'y' });
    expect(normalizeCandidatePair('y', 'x')).toEqual({ low: 'x', high: 'y' });
  });
});

describe('suspected duplicate: mark only, never auto-merge', () => {
  it('registers a suspected relation without mutating either candidate', () => {
    const { a, b } = makeTwoCandidates();
    const candRepo = new RadarCandidateRepository(db);
    const aBefore = candRepo.getCandidate(a)!;
    const bBefore = candRepo.getCandidate(b)!;

    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, { companyNameSimilar: true }, 'same_company_role');
    expect(rel.status).toBe('suspected_duplicate');

    // 两个候选完全未被改动（不合并、不改 lifecycle、不改 active version）。
    expect(candRepo.getCandidate(a)).toEqual(aBefore);
    expect(candRepo.getCandidate(b)).toEqual(bBefore);
    expect(candRepo.getCandidate(a)!.lifecycleStatus).toBe('active');
    expect(candRepo.getCandidate(b)!.lifecycleStatus).toBe('active');
  });

  it('(A,B) then (B,A) is the same relation (no duplicate rows)', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const r1 = svc.registerSuspectedDuplicate(a, b, {}, null);
    const r2 = svc.registerSuspectedDuplicate(b, a, {}, null);
    expect(r2.id).toBe(r1.id);
    expect((db.prepare('SELECT COUNT(*) c FROM radar_candidate_relations').get() as { c: number }).c).toBe(1);
  });

  it('rejects a self relation', () => {
    const { a } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    expect(() => svc.registerSuspectedDuplicate(a, a, {}, null)).toThrow(/SAME_CANDIDATE_RELATION|自身/);
  });
});

describe('confirmed_distinct: persist + no re-prompt', () => {
  it('confirming distinct persists decision and appends duplicate_rejected action', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, { companyNameSimilar: true }, 'same_company_role');
    const resolved = svc.confirmDistinct(rel.id, '两家不同公司');
    expect(resolved.status).toBe('confirmed_distinct');
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolutionActionId).not.toBeNull();

    const actionRepo = new RadarActionRepository(db);
    const action = actionRepo.getById(resolved.resolutionActionId!)!;
    expect(action.actionType).toBe('duplicate_rejected');
    expect((action.metadata as { relationId: string }).relationId).toBe(rel.id);
    expect((action.metadata as { counterpartCandidateId: string }).counterpartCandidateId).toBe(rel.candidateIdHigh);
  });

  it('re-registering the same pair after confirmed_distinct does NOT re-prompt (stays confirmed_distinct)', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, {}, null);
    svc.confirmDistinct(rel.id, 'not the same');
    // 同一批旧信号再次出现：不重新提示，保持 confirmed_distinct。
    const again = svc.registerSuspectedDuplicate(a, b, {}, null);
    expect(again.status).toBe('confirmed_distinct');
    const relRepo = new RadarCandidateRelationRepository(db);
    expect(relRepo.listByStatus('suspected_duplicate')).toHaveLength(0);
  });
});

describe('needs_recheck: only new material evidence', () => {
  it('allows recheck with an approved evidence reason', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, {}, null);
    svc.confirmDistinct(rel.id, 'distinct');
    const rechecked = svc.requestRecheck(rel.id, 'new_material_version', 'B 候选产生了新的实质版本');
    expect(rechecked.status).toBe('needs_recheck');
    const actionRepo = new RadarActionRepository(db);
    const action = actionRepo.getById(rechecked.resolutionActionId!)!;
    expect(action.actionType).toBe('duplicate_recheck_requested');
    expect((action.metadata as { evidenceReason: string }).evidenceReason).toBe('new_material_version');
  });

  it('rejects recheck with a non-substantive reason (capturedAt/activity/confidence)', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, {}, null);
    svc.confirmDistinct(rel.id, 'distinct');
    // @ts-expect-error 故意传入非允许证据以验证运行时拒绝
    expect(() => svc.requestRecheck(rel.id, 'capturedAt_changed', null)).toThrow(/RECHECK_NOT_ALLOWED|不允许/);
    // @ts-expect-error 同上
    expect(() => svc.requestRecheck(rel.id, 'recruiter_activity_changed', null)).toThrow(/RECHECK_NOT_ALLOWED|不允许/);
  });
});

describe('confirmed_same: adjudication only, no irreversible merge', () => {
  it('marks confirmed_same and appends duplicate_confirmed, but does NOT delete/merge candidates', () => {
    const { a, b } = makeTwoCandidates();
    const candRepo = new RadarCandidateRepository(db);
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, {}, null);
    const resolved = svc.confirmSame(rel.id, '确实是同一岗位');
    expect(resolved.status).toBe('confirmed_same');

    // 两个候选均仍存在且 active（不物理删除、不 merged、不改 active version）。
    expect(candRepo.getCandidate(a)!.lifecycleStatus).toBe('active');
    expect(candRepo.getCandidate(b)!.lifecycleStatus).toBe('active');
    expect(candRepo.getCandidate(a)!.mergedIntoCandidateId).toBeNull();
    expect(candRepo.getCandidate(b)!.mergedIntoCandidateId).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM radar_candidates').get() as { c: number }).c).toBe(2);

    const actionRepo = new RadarActionRepository(db);
    expect(actionRepo.getById(resolved.resolutionActionId!)!.actionType).toBe('duplicate_confirmed');
  });
});

describe('revert decision: appends event, returns to suspected, keeps history', () => {
  it('revert creates a new duplicate_decision_reverted action and does not delete prior actions', () => {
    const { a, b } = makeTwoCandidates();
    const svc = new RadarDuplicateAdjudicationService(db, deps());
    const rel = svc.registerSuspectedDuplicate(a, b, {}, null);
    const distinct = svc.confirmDistinct(rel.id, 'distinct');
    const reverted = svc.revertDecision(rel.id, '误判，撤销');
    expect(reverted.status).toBe('suspected_duplicate');

    const actionRepo = new RadarActionRepository(db);
    // 撤销前的 duplicate_rejected 事件仍在（追加式，不删除历史）。
    expect(actionRepo.getById(distinct.resolutionActionId!)).not.toBeNull();
    expect(actionRepo.getById(reverted.resolutionActionId!)!.actionType).toBe('duplicate_decision_reverted');
    // 该候选至少有 2 条 duplicate_* 审计事件。
    const dupActions = actionRepo.listByCandidate(rel.candidateIdLow).filter((x) => x.actionType.startsWith('duplicate_'));
    expect(dupActions.length).toBeGreaterThanOrEqual(2);
  });
});
