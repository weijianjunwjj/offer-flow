import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { AnalysisRecordRepository } from '../analysisRecordRepository';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { RadarRuleAssessmentRepository } from '../ruleAssessmentRepository';
import { RadarActionRepository } from '../actionRepository';
import { seedActiveResumeAndProfile } from '../analysis/analysisInputFixture';
import { validPayload, validSnapshot } from '../analysis/contractFixtures';
import { FakeNovaWingHostAdapter } from '../analysis/fakeNovaWingHostAdapter.specHelper';
import {
  JOB_MATCH_ANALYSIS_POLICY_VERSION,
  JOB_MATCH_ANALYSIS_PROMPT_VERSION,
} from '../analysis/analysisPrompt';
import type { JobMatchAnalysisRecord, JobMatchRecommendation, JobMatchConfidence, RadarAction, RadarRuleAssessment } from '../../../src/domain/radar';
import { RecommendationBatchService } from './recommendationBatchService';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

let seq = 0;
function captureDeps() {
  let s = 0;
  return { now: () => 1_700_000_000 + s, createId: () => `cap-${(seq += 1)}-${(s += 1)}` };
}

/** v7 沙箱 + 正式简历/画像 seed（current 记录的比较对照面）。 */
function setup(): { db: SqliteDatabase; service: RecommendationBatchService } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-rec-batch-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  seedActiveResumeAndProfile(db, 1_700_000_000);
  let clock = 1_800_000_000;
  const service = new RecommendationBatchService({
    db, now: () => (clock += 1), createBatchId: () => `batch-${(seq += 1)}`,
  });
  cleanups.push(() => { db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { db, service };
}

/** 经采集桥落一个真实候选 + 正式版本（externalRecordId 区分不同候选）。 */
function seedCandidate(db: SqliteDatabase, tag: string): { candidateId: string; versionId: string } {
  const capture = new RadarCaptureService(db, captureDeps());
  const s = capture.createSession({ sourceType: 'browser' });
  capture.addItem(s.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: `https://www.zhipin.com/job_detail/${tag}.html`, sourceDomain: 'zhipin.com', pageTitle: null,
    visibleText: `岗位描述：后端工程师 @ 公司${tag}，工作地 苏州。`, externalRecordId: tag,
    recognizedFields: {
      company: `公司${tag}`, role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  return { candidateId: outcome.candidateId!, versionId: outcome.candidateVersionId! };
}

/**
 * 直接插入一条 current 分析记录：版本戳与 seed 的正式上下文一致（resume/profile 匹配，
 * baseline/market/strategy=null，ruleVersion='none' 当无评估，prompt/policy=常量）→ deriveAnalysisValidity=current。
 */
function insertCurrentRecord(
  db: SqliteDatabase,
  c: { candidateId: string; versionId: string },
  opts: { recommendation: JobMatchRecommendation; confidence: JobMatchConfidence; ruleVersion?: string; tag: string },
): JobMatchAnalysisRecord {
  const record: JobMatchAnalysisRecord = {
    id: `rec-${opts.tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId,
    resumeVersionId: 'resume-ver-1', jobMatchProfileVersionId: 'jmp-ver-1', cityCode: 'suzhou',
    capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
    ruleVersion: opts.ruleVersion ?? 'none', promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
    analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION, modelProvider: 'fake', modelName: 'fake-model',
    modelVersion: null, inputHash: `hash-${opts.tag}`, recommendation: opts.recommendation, confidence: opts.confidence,
    payload: validPayload({ recommendation: opts.recommendation, confidence: opts.confidence }),
    createdAt: 1_700_000_500, supersedesAnalysisId: null,
  };
  new AnalysisRecordRepository(db).insert(record);
  return record;
}

function linkFrozenNovaWingRevision(
  db: SqliteDatabase,
  record: JobMatchAnalysisRecord,
  coreRevision: number,
): void {
  const snapshot = validSnapshot();
  new AnalysisTaskRepository(db).insert({
    id: `task-${record.id}`,
    taskType: 'job_match_analysis',
    entityType: 'radar_candidate_version',
    entityId: record.candidateVersionId,
    status: 'succeeded',
    inputHash: record.inputHash,
    inputSnapshot: {
      ...snapshot,
      contractVersion: 2,
      novaWingContext: {
        coreRevision,
        scopes: ['global', 'career'],
        entries: [{ scope: 'global', key: 'global.summary', value: 'safe' }],
      },
    },
    attemptCount: 1,
    maxAttempts: 3,
    startedAt: 1_700_000_450,
    finishedAt: 1_700_000_500,
    cancelledAt: null,
    errorCode: null,
    errorMessage: null,
    resultRecordId: record.id,
    createdAt: 1_700_000_400,
    updatedAt: 1_700_000_500,
  });
}

function insertHardConstraintHit(db: SqliteDatabase, c: { candidateId: string; versionId: string }, tag: string): void {
  const assessment: RadarRuleAssessment = {
    id: `ra-${tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId, ruleVersion: 'rules-v1',
    ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'high', result: 'hit',
    matchedText: null, sourcePath: null, explanation: '薪资不达标', evidenceJson: null, createdAt: 1_700_000_400,
  };
  new RadarRuleAssessmentRepository(db).insert(assessment);
}

function insertAction(db: SqliteDatabase, c: { candidateId: string; versionId: string }, type: RadarAction['actionType'], tag: string): void {
  const action: RadarAction = {
    id: `act-${tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId, actionType: type,
    reasonCode: null, reasonText: null, metadata: {}, occurredAt: 1_700_000_450, revertedByActionId: null, createdAt: 1_700_000_450,
  };
  new RadarActionRepository(db).insert(action);
}

/** 断言下游正式对象零写入（jobs / applications / feedback_events）。 */
function assertNoDownstreamWrites(db: SqliteDatabase): void {
  for (const table of ['jobs', 'applications', 'feedback_events']) {
    const { c } = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    expect(c, `${table} 必须零写入`).toBe(0);
  }
}

describe('RecommendationBatchService.createBatch', () => {
  it('persists a legal 0-recommendation batch when all candidates lack current analysis', () => {
    const { db, service } = setup();
    const c = seedCandidate(db, 'c1'); // 无分析记录 → no_current_analysis 排除
    const { batch, created } = service.createBatch([c.versionId]);
    expect(created).toBe(true);
    expect(batch.selectedCandidateVersionIds).toEqual([]);
    expect(batch.emptyReason).toBe('no_current_successful_analysis');
    const stored = service.getBatch(batch.id)!;
    expect(stored.status).toBe('succeeded');
    assertNoDownstreamWrites(db);
  });

  it('persists 1-8 recommendations with selectedCandidateVersionIds matching the result order', () => {
    const { db, service } = setup();
    const versions: string[] = [];
    for (const [i, rec] of (['apply_now', 'stretch', 'verify'] as JobMatchRecommendation[]).entries()) {
      const c = seedCandidate(db, `m${i}`);
      insertCurrentRecord(db, c, { recommendation: rec, confidence: 'high', tag: `m${i}` });
      versions.push(c.versionId);
    }
    const { batch } = service.createBatch(versions);
    expect(batch.selectedCandidateVersionIds).toHaveLength(3);
    // scope 内冻结的富结果与 selected 完全一致（顺序 apply_now → stretch → verify）。
    const set = (batch.scope as { recommendationSet: { recommendations: { candidateVersionId: string; kind: string }[] } }).recommendationSet;
    expect(set.recommendations.map((r) => r.kind)).toEqual(['apply_now', 'stretch', 'verify']);
    expect(set.recommendations.map((r) => r.candidateVersionId)).toEqual(batch.selectedCandidateVersionIds);
    assertNoDownstreamWrites(db);
  });

  it('truncates to 8 recommendations when more than 8 candidates are eligible', () => {
    const { db, service } = setup();
    const versions: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const c = seedCandidate(db, `t${i}`);
      insertCurrentRecord(db, c, { recommendation: 'apply_now', confidence: 'high', tag: `t${i}` });
      versions.push(c.versionId);
    }
    const { batch } = service.createBatch(versions);
    expect(batch.selectedCandidateVersionIds).toHaveLength(8);
    expect(batch.candidateVersionIds).toHaveLength(11);
    assertNoDownstreamWrites(db);
  });

  it('excludes stale / skip / ignored / applied candidates', () => {
    const { db, service } = setup();
    const keep = seedCandidate(db, 'keep');
    insertCurrentRecord(db, keep, { recommendation: 'apply_now', confidence: 'high', tag: 'keep' });

    const stale = seedCandidate(db, 'stale');
    // ruleVersion 与当前 active 不一致（无评估时当前为 'none'）→ stale
    insertCurrentRecord(db, stale, { recommendation: 'apply_now', confidence: 'high', ruleVersion: 'rules-vOLD', tag: 'stale' });

    const skip = seedCandidate(db, 'skip');
    insertCurrentRecord(db, skip, { recommendation: 'skip', confidence: 'high', tag: 'skip' });

    const ignored = seedCandidate(db, 'ign');
    insertCurrentRecord(db, ignored, { recommendation: 'apply_now', confidence: 'high', tag: 'ign' });
    insertAction(db, ignored, 'ignored', 'ign');

    const applied = seedCandidate(db, 'app');
    insertCurrentRecord(db, applied, { recommendation: 'apply_now', confidence: 'high', tag: 'app' });
    insertAction(db, applied, 'marked_applied_pending', 'app');

    const scope = [keep, stale, skip, ignored, applied].map((c) => c.versionId);
    const { batch } = service.createBatch(scope);
    expect(batch.selectedCandidateVersionIds).toEqual([keep.versionId]);
    assertNoDownstreamWrites(db);
  });

  it('is idempotent: same scope + unchanged state reuses the same batch (no second row)', () => {
    const { db, service } = setup();
    const c = seedCandidate(db, 'idem');
    insertCurrentRecord(db, c, { recommendation: 'apply_now', confidence: 'high', tag: 'idem' });
    const first = service.createBatch([c.versionId]);
    const second = service.createBatch([c.versionId]);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.batch.id).toBe(first.batch.id);
    const { count } = db.prepare('SELECT COUNT(*) count FROM radar_recommendation_batches').get() as { count: number };
    expect(count).toBe(1);
  });

  it('hard-constraint hit is excluded from recommendations', () => {
    const { db, service } = setup();
    const c = seedCandidate(db, 'hc');
    // 记录 ruleVersion 必须匹配当前（有 hard_constraint 评估 → currentRuleVersion='rules-v1'）
    insertCurrentRecord(db, c, { recommendation: 'apply_now', confidence: 'high', ruleVersion: 'rules-v1', tag: 'hc' });
    insertHardConstraintHit(db, c, 'hc');
    const { batch } = service.createBatch([c.versionId]);
    expect(batch.selectedCandidateVersionIds).toEqual([]);
    expect(batch.emptyReason).toBe('all_candidates_excluded');
  });

  it('reads the current NovaWing revision once per batch (no N+1) and excludes changed contexts', () => {
    const { db } = setup();
    const fake = new FakeNovaWingHostAdapter({ coreRevision: 10, entries: [] });
    let batchSeq = 0;
    const service = new RecommendationBatchService({
      db,
      now: () => 1_900_000_000 + batchSeq,
      createBatchId: () => `nw-batch-${(batchSeq += 1)}`,
      novaWingAnalysisContextEnabled: true,
      novaWingHostAdapter: fake,
    });
    const candidates = Array.from({ length: 3 }, (_, index) => seedCandidate(db, `nw-${index}`));
    for (const [index, candidate] of candidates.entries()) {
      const record = insertCurrentRecord(db, candidate, {
        recommendation: 'apply_now', confidence: 'high', tag: `nw-${index}`,
      });
      linkFrozenNovaWingRevision(db, record, 10);
    }

    fake.resetCalls();
    const current = service.createBatch(candidates.map((candidate) => candidate.versionId));
    expect(fake.callCount).toBe(1);
    expect(current.batch.selectedCandidateVersionIds).toHaveLength(3);

    fake.setRevision(11);
    fake.resetCalls();
    const stale = service.createBatch(candidates.map((candidate) => candidate.versionId));
    expect(fake.callCount).toBe(1);
    expect(stale.batch.selectedCandidateVersionIds).toEqual([]);
    const recommendationSet = (stale.batch.scope as {
      recommendationSet: { blocked: Array<{ reason: string }> };
    }).recommendationSet;
    expect(recommendationSet.blocked.map((item) => item.reason)).toEqual([
      'stale_analysis', 'stale_analysis', 'stale_analysis',
    ]);
  });

  it('rejects empty scope', () => {
    const { service } = setup();
    expect(() => service.createBatch([])).toThrow(/scope/);
  });

  it('throws candidate-not-found for unknown version id', () => {
    const { service } = setup();
    expect(() => service.createBatch(['nonexistent-version'])).toThrow(/候选版本不存在/);
  });
});
