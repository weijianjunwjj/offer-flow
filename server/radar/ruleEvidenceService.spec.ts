import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { RadarCaptureService } from './service';
import { RadarRuleAssessmentRepository } from './ruleAssessmentRepository';
import { RadarActionRepository } from './actionRepository';
import { RadarRuleEvidenceService } from './ruleEvidenceService';
import type { RuleEvidence } from './ruleEvidenceContract';

let db: SqliteDatabase;
let tempDir: string;
let counter = 0;
let clock = 3_000_000;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-w5-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  counter = 0;
  clock = 3_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deps() {
  return { now: () => (clock += 1000), createId: () => `id-${(counter += 1)}` };
}

/** 建一个候选，返回 { candidateId, versionId }。 */
function makeCandidate(): { candidateId: string; versionId: string } {
  const svc = new RadarCaptureService(db, deps());
  const s = svc.createSession({ sourceType: 'browser' });
  svc.addItem(s.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: 'https://www.zhipin.com/job_detail/w5.html', sourceDomain: 'zhipin.com',
    pageTitle: null, visibleText: 'jd', externalRecordId: 'w5-ext',
    recognizedFields: { company: 'C', role: '前端', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月', experienceRequirement: null, educationRequirement: null },
    extractionMetadata: null, capturedAt: null,
  });
  const res = svc.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] });
  return { candidateId: res.outcomes[0]!.candidateId!, versionId: res.outcomes[0]!.candidateVersionId! };
}

function evidence(over: Partial<RuleEvidence> = {}): RuleEvidence {
  return {
    contractVersion: 1, ruleId: 'salary_floor', ruleVersion: 'rules-v1', ruleCategory: 'hard_constraint',
    candidateId: 'c', candidateVersionId: 'v', outcome: 'matched', sourceSnapshotId: 'snap-1',
    matchedFieldPath: 'salaryMinK', rawValue: '15', normalizedValue: 15,
    evidenceExcerpt: '薪资 15K 低于下限', evidenceSource: 'normalized_field', explanation: '低于下限',
    severity: 'blocking', confidence: 0.9, blocking: true, matches: [], userOverrideState: 'none',
    ...over,
  } as RuleEvidence;
}

describe('Wave5 rule evidence: write + structured read', () => {
  it('writes a valid evidence_json and reads it back as structured', () => {
    const { candidateId, versionId } = makeCandidate();
    const svc = new RadarRuleEvidenceService(db, deps());
    svc.recordAssessment({
      id: 'a1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
      matchedText: '15K', sourcePath: 'salaryMinK', explanation: '低于下限',
      evidence: evidence({ candidateId, candidateVersionId: versionId }),
    });
    const views = svc.listEvidenceByVersion(versionId);
    expect(views).toHaveLength(1);
    expect(views[0]!.evidenceState).toBe('structured');
    if (views[0]!.evidenceState === 'structured') {
      expect(views[0]!.evidence.ruleId).toBe('salary_floor');
      expect(views[0]!.evidence.outcome).toBe('matched');
    }
  });

  it('rejects illegal evidence at write time (never persists illegal evidence)', () => {
    const { candidateId, versionId } = makeCandidate();
    const svc = new RadarRuleEvidenceService(db, deps());
    const base = {
      id: 'a-bad', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint' as const, severity: 'blocking',
      result: 'hit' as const, matchedText: null, sourcePath: null, explanation: 'x',
    };
    expect(() => svc.recordAssessment({ ...base, evidence: evidence({ confidence: 2 }) })).toThrow();
    expect(() => svc.recordAssessment({ ...base, evidence: evidence({ evidenceExcerpt: '啊'.repeat(201) }) })).toThrow();
    expect(() => svc.recordAssessment({ ...base, evidence: evidence({ evidenceExcerpt: 'securityId=abc' }) })).toThrow();
    // 无非法行落库。
    expect(new RadarRuleAssessmentRepository(db).listByCandidateVersion(versionId)).toHaveLength(0);
  });
});

describe('Wave5 rule evidence: legacy + corrupt handling', () => {
  it('legacy NULL evidence row falls back to scalar fields', () => {
    const { candidateId, versionId } = makeCandidate();
    // 直接以旧式写入（evidenceJson=null）。
    new RadarRuleAssessmentRepository(db).insert({
      id: 'legacy-1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
      matchedText: '15K', sourcePath: 'salaryMinK', explanation: '低于下限', evidenceJson: null, createdAt: 100,
    });
    const views = new RadarRuleEvidenceService(db, deps()).listEvidenceByVersion(versionId);
    expect(views[0]!.evidenceState).toBe('legacy_scalar');
    expect(views[0]!.assessment.matchedText).toBe('15K');
  });

  it('non-null but corrupt evidence is explicitly marked, not silently ignored', () => {
    const { candidateId, versionId } = makeCandidate();
    new RadarRuleAssessmentRepository(db).insert({
      id: 'corrupt-1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
      matchedText: '15K', sourcePath: 'salaryMinK', explanation: 'x', evidenceJson: '{"contractVersion":1,"broken":true}', createdAt: 100,
    });
    const views = new RadarRuleEvidenceService(db, deps()).listEvidenceByVersion(versionId);
    expect(views[0]!.evidenceState).toBe('corrupt');
    if (views[0]!.evidenceState === 'corrupt') expect(views[0]!.corruptReason).toBeTruthy();
  });
});

describe('Wave5 rule evidence: outcome semantics + multi-match', () => {
  it('distinguishes unknown / not_matched / rule_error and preserves multiple matches', () => {
    const { candidateId, versionId } = makeCandidate();
    const svc = new RadarRuleEvidenceService(db, deps());
    const write = (id: string, outcome: RuleEvidence['outcome'], matches: RuleEvidence['matches'] = []) =>
      svc.recordAssessment({
        id, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1', ruleKey: id,
        category: 'risk', severity: 'warn', result: outcome === 'matched' ? 'hit' : outcome === 'unknown' ? 'unknown' : 'pass',
        matchedText: null, sourcePath: null, explanation: 'x',
        evidence: evidence({ candidateId, candidateVersionId: versionId, ruleId: id, outcome, blocking: false, matchedFieldPath: outcome === 'unknown' ? null : 'city', matches }),
      });
    write('r_unknown', 'unknown');
    write('r_notmatched', 'not_matched');
    write('r_error', 'rule_error');
    write('r_multi', 'matched', [
      { fieldPath: 'city', excerpt: '上海', rawValue: '上海', normalizedValue: '上海' },
      { fieldPath: 'salaryMinK', excerpt: '15K', rawValue: '15', normalizedValue: 15 },
    ]);
    const byId = new Map(svc.listEvidenceByVersion(versionId).map((v) => [v.assessment.ruleKey, v]));
    const outcomeOf = (k: string) => {
      const v = byId.get(k)!;
      return v.evidenceState === 'structured' ? v.evidence.outcome : null;
    };
    expect(outcomeOf('r_unknown')).toBe('unknown');
    expect(outcomeOf('r_notmatched')).toBe('not_matched');
    expect(outcomeOf('r_error')).toBe('rule_error');
    const multi = byId.get('r_multi')!;
    if (multi.evidenceState === 'structured') expect(multi.evidence.matches).toHaveLength(2);
  });
});

describe('Wave5 user override audit', () => {
  it('override appends RadarAction without deleting/mutating the assessment', () => {
    const { candidateId, versionId } = makeCandidate();
    const svc = new RadarRuleEvidenceService(db, deps());
    svc.recordAssessment({
      id: 'a1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
      matchedText: '15K', sourcePath: 'salaryMinK', explanation: '低于下限',
      evidence: evidence({ candidateId, candidateVersionId: versionId }),
    });
    const assessment = new RadarRuleAssessmentRepository(db).listByCandidateVersion(versionId)[0]!;

    const override = svc.setRuleOverride({ assessment, decision: 'pass', reason: '可接受', actor: 'user', sourceSnapshotId: 'snap-1' });
    expect(override.actionType).toBe('rule_override_set');
    expect((override.metadata as { ruleAssessmentId: string }).ruleAssessmentId).toBe(assessment.id);
    expect((override.metadata as { originalResult: string }).originalResult).toBe('hit');

    // 原始规则评估未被删除或改写。
    const after = new RadarRuleAssessmentRepository(db).listByCandidateVersion(versionId);
    expect(after).toHaveLength(1);
    expect(after[0]!.result).toBe('hit');
    expect(after[0]!.id).toBe(assessment.id);
  });

  it('revert appends a new rule_override_reverted action and back-fills reverted_by (restore-default is a new event)', () => {
    const { candidateId, versionId } = makeCandidate();
    const svc = new RadarRuleEvidenceService(db, deps());
    svc.recordAssessment({
      id: 'a1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
      ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
      matchedText: null, sourcePath: null, explanation: 'x',
      evidence: evidence({ candidateId, candidateVersionId: versionId }),
    });
    const assessment = new RadarRuleAssessmentRepository(db).listByCandidateVersion(versionId)[0]!;
    const override = svc.setRuleOverride({ assessment, decision: 'pass', reason: 'ok', actor: 'user', sourceSnapshotId: null });
    const revert = svc.revertRuleOverride({ overrideActionId: override.id, reason: '恢复默认', actor: 'user' });

    expect(revert.actionType).toBe('rule_override_reverted');
    const actionRepo = new RadarActionRepository(db);
    // 原 override 事件仍存在且被回填 reverted_by。
    const originalAfter = actionRepo.getById(override.id)!;
    expect(originalAfter.revertedByActionId).toBe(revert.id);
    // 候选下同时存在 set 与 reverted 两条事件（追加式，不删除）。
    const overrideActions = actionRepo.listByCandidate(candidateId).filter((a) => a.actionType.startsWith('rule_override_'));
    expect(overrideActions).toHaveLength(2);
  });
});
