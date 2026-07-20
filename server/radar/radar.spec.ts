import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { AnalysisRecordRepository } from './analysisRecordRepository';
import { AnalysisTaskRepository } from './analysisTaskRepository';
import { RadarActionRepository } from './actionRepository';
import { RadarCandidateRepository } from './candidateRepository';
import { RadarCaptureRepository } from './captureRepository';
import { RadarPromotionRepository } from './promotionRepository';
import { RadarRecommendationBatchRepository } from './recommendationBatchRepository';
import { RadarRuleAssessmentRepository } from './ruleAssessmentRepository';
import { RadarSourceRecordRepository } from './sourceRecordRepository';

let tempDir: string;
let db: SqliteDatabase;

function normalizedFixture() {
  return {
    company: 'Acme', role: 'Engineer', city: 'sz', district: null,
    salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month', experienceRequirement: null,
    educationRequirement: null, companySize: null, industry: null, jobNature: null,
    workMode: null, technicalStack: [], responsibilities: [], requirements: [],
    publishedAt: null, rawDescription: 'raw text',
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 7 });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('schema v7', () => {
  it('creates all 12 radar domain tables and stays FK-consistent', () => {
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>).map((row) => row.name);
    for (const table of [
      'radar_capture_sessions', 'radar_capture_snapshots', 'radar_source_records',
      'radar_candidates', 'radar_candidate_versions', 'radar_candidate_sources',
      'radar_rule_assessments', 'analysis_tasks', 'job_match_analysis_records',
      'radar_recommendation_batches', 'radar_actions', 'radar_promotions',
    ]) {
      expect(tables).toContain(table);
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not create radar tables at the default production target', () => {
    const prodTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-radar-prod-'));
    const prodDb = openDb(path.join(prodTempDir, 'prod.sqlite3'));
    initSchema(prodDb);
    const tables = (prodDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'radar_candidates'")
      .all() as unknown[]);
    expect(tables).toHaveLength(0);
    prodDb.close();
    fs.rmSync(prodTempDir, { recursive: true, force: true });
  });
});

describe('RadarCaptureRepository', () => {
  it('round-trips a capture session and enforces committed_at consistency', () => {
    const repo = new RadarCaptureRepository(db);
    repo.insertSession({
      id: 'session-1', sourceType: 'pasted_text', status: 'preview',
      rawInput: { text: 'raw' }, previewItems: [{ index: 0 }],
      createdAt: 100, expiresAt: 200, committedAt: null,
    });
    expect(repo.getSession('session-1')).toMatchObject({ status: 'preview', committedAt: null });

    expect(repo.updateSessionStatus('session-1', 'committed', 150)).toBe(true);
    expect(repo.getSession('session-1')).toMatchObject({ status: 'committed', committedAt: 150 });

    expect(() =>
      db.prepare(
        `INSERT INTO radar_capture_sessions (id, source_type, status, raw_input_json, preview_items_json, created_at, expires_at, committed_at)
         VALUES ('bad', 'json', 'committed', '{}', '[]', 100, 200, NULL)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('round-trips an immutable capture snapshot linked to a session', () => {
    const repo = new RadarCaptureRepository(db);
    repo.insertSession({
      id: 'session-2', sourceType: 'browser', status: 'preview',
      rawInput: {}, previewItems: [], createdAt: 100, expiresAt: 200, committedAt: null,
    });
    repo.insertSnapshot({
      id: 'snap-1', captureSessionId: 'session-2', captureMethod: 'boss_current_page',
      providerKey: 'boss', providerVersion: 'v1', sourceDomain: 'zhipin.com',
      sourceUrl: 'https://zhipin.com/job/1', normalizedSourceUrl: 'zhipin.com/job/1',
      externalRecordId: 'ext-1', pageTitle: 'Engineer', visibleText: 'visible text',
      rawSnapshot: { html: '<div/>' }, rawContentHash: 'hash-1', capturedAt: 120, createdAt: 120,
    });
    const snapshot = repo.getSnapshot('snap-1');
    expect(snapshot?.rawSnapshot).toEqual({ html: '<div/>' });
    expect(repo.listSnapshotsBySession('session-2')).toHaveLength(1);
  });
});

function insertSnapshotFixture(db: SqliteDatabase, id: string): void {
  new RadarCaptureRepository(db).insertSnapshot({
    id, captureSessionId: null, captureMethod: 'pasted_text', providerKey: null,
    providerVersion: null, sourceDomain: null, sourceUrl: null, normalizedSourceUrl: null,
    externalRecordId: null, pageTitle: null, visibleText: 'text', rawSnapshot: {},
    rawContentHash: `hash-${id}`, capturedAt: 100, createdAt: 100,
  });
}

describe('RadarSourceRecordRepository', () => {
  it('round-trips and finds by providerKey+externalRecordId', () => {
    insertSnapshotFixture(db, 'snap-src-1');
    const repo = new RadarSourceRecordRepository(db);
    repo.insert({
      id: 'source-1', providerKey: 'boss', externalRecordId: 'ext-1', normalizedSourceUrl: null,
      firstSeenAt: 100, lastSeenAt: 100, lastChangedAt: null, latestSnapshotId: 'snap-src-1',
      sourceStatus: 'active', createdAt: 100, updatedAt: 100,
    });
    expect(repo.findByProviderKey('boss', 'ext-1')?.id).toBe('source-1');
    expect(repo.updateLatestSnapshot('source-1', 'snap-src-1', 200, 150, 200)).toBe(true);
    expect(repo.getById('source-1')?.lastSeenAt).toBe(200);
  });
});

describe('RadarCandidateRepository', () => {
  it('creates candidate + version via the three-step transaction and backfills active_version_id', () => {
    const repo = new RadarCandidateRepository(db);
    const tx = db.transaction(() => {
      repo.insertCandidate({
        id: 'cand-1', primarySourceRecordId: null, activeVersionId: null,
        lifecycleStatus: 'active', mergedIntoCandidateId: null, createdAt: 100, updatedAt: 100,
      });
      repo.insertVersion({
        id: 'ver-1', candidateId: 'cand-1', versionNo: 1, normalized: normalizedFixture(),
        qualityIssues: [], sourceSnapshotIds: [], contentHash: 'hash-1', originType: 'captured',
        correctionNote: null, supersedesVersionId: null, createdAt: 100,
      });
      repo.setActiveVersionId('cand-1', 'ver-1', 100);
    });
    tx();

    const candidate = repo.getCandidate('cand-1');
    expect(candidate?.activeVersionId).toBe('ver-1');
    expect(candidate?.lifecycleStatus).toBe('active');
    expect(repo.listActiveCandidates()).toHaveLength(1);
  });

  it('rejects candidate rows that violate lifecycle/merged_into invariants', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO radar_candidates (id, active_version_id, lifecycle_status, created_at, updated_at)
         VALUES ('bad-active', NULL, 'active', 100, 100)`,
      ).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO radar_candidates (id, active_version_id, lifecycle_status, merged_into_candidate_id, created_at, updated_at)
         VALUES ('bad-merged', NULL, 'merged', NULL, 100, 100)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('assigns incrementing version numbers and finds versions by content hash; never exposes an UPDATE method', () => {
    const repo = new RadarCandidateRepository(db);
    db.transaction(() => {
      repo.insertCandidate({
        id: 'cand-2', primarySourceRecordId: null, activeVersionId: null,
        lifecycleStatus: 'active', mergedIntoCandidateId: null, createdAt: 100, updatedAt: 100,
      });
      repo.insertVersion({
        id: 'ver-2a', candidateId: 'cand-2', versionNo: repo.nextVersionNo('cand-2'),
        normalized: normalizedFixture(), qualityIssues: [], sourceSnapshotIds: [],
        contentHash: 'hash-a', originType: 'captured', correctionNote: null,
        supersedesVersionId: null, createdAt: 100,
      });
      repo.setActiveVersionId('cand-2', 'ver-2a', 100);
    })();

    expect(repo.nextVersionNo('cand-2')).toBe(2);
    repo.insertVersion({
      id: 'ver-2b', candidateId: 'cand-2', versionNo: 2, normalized: normalizedFixture(),
      qualityIssues: [], sourceSnapshotIds: [], contentHash: 'hash-b', originType: 'manual_correction',
      correctionNote: 'fixed salary', supersedesVersionId: 'ver-2a', createdAt: 200,
    });
    expect(repo.listVersionsByCandidate('cand-2').map((v) => v.id)).toEqual(['ver-2b', 'ver-2a']);
    expect(repo.findVersionByContentHash('cand-2', 'hash-a')?.id).toBe('ver-2a');

    expect(typeof (repo as unknown as Record<string, unknown>).updateVersion).toBe('undefined');
  });
});

function insertCandidateWithVersion(db: SqliteDatabase, candidateId: string, versionId: string): void {
  const repo = new RadarCandidateRepository(db);
  db.transaction(() => {
    repo.insertCandidate({
      id: candidateId, primarySourceRecordId: null, activeVersionId: null,
      lifecycleStatus: 'active', mergedIntoCandidateId: null, createdAt: 100, updatedAt: 100,
    });
    repo.insertVersion({
      id: versionId, candidateId, versionNo: 1, normalized: normalizedFixture(),
      qualityIssues: [], sourceSnapshotIds: [], contentHash: `hash-${versionId}`,
      originType: 'captured', correctionNote: null, supersedesVersionId: null, createdAt: 100,
    });
    repo.setActiveVersionId(candidateId, versionId, 100);
  })();
}

describe('RadarRuleAssessmentRepository', () => {
  it('appends rule assessments per candidate version', () => {
    insertCandidateWithVersion(db, 'cand-r1', 'ver-r1');
    const repo = new RadarRuleAssessmentRepository(db);
    repo.insert({
      id: 'assess-1', candidateId: 'cand-r1', candidateVersionId: 'ver-r1',
      ruleVersion: 'rules-v1', ruleKey: 'salary_below_floor', category: 'hard_constraint',
      severity: 'blocking', result: 'hit', matchedText: '15K', sourcePath: 'salaryMinK',
      explanation: 'below floor', createdAt: 100,
    });
    expect(repo.listByCandidateVersion('ver-r1')).toHaveLength(1);
  });
});

describe('AnalysisTaskRepository', () => {
  it('round-trips a task through the queued→running→succeeded lifecycle', () => {
    const repo = new AnalysisTaskRepository(db);
    repo.insert({
      id: 'task-1', taskType: 'job_match_analysis', entityType: 'radar_candidate_version',
      entityId: 'ver-x', status: 'queued', inputHash: 'input-1', inputSnapshot: { a: 1 },
      attemptCount: 0, maxAttempts: 3, startedAt: null, finishedAt: null, cancelledAt: null,
      errorCode: null, errorMessage: null, resultRecordId: null, createdAt: 100, updatedAt: 100,
    });
    const running = { ...repo.getById('task-1')!, status: 'running' as const, startedAt: 110, attemptCount: 1, updatedAt: 110 };
    expect(repo.updateStatus(running)).toBe(true);
    expect(repo.listByStatus('running')).toHaveLength(1);

    const succeeded = { ...running, status: 'succeeded' as const, finishedAt: 130, resultRecordId: 'record-1', updatedAt: 130 };
    expect(repo.updateStatus(succeeded)).toBe(true);
    expect(repo.getById('task-1')?.resultRecordId).toBe('record-1');
  });

  it('rejects a queued task that already has started_at set', () => {
    expect(() =>
      db.prepare(`
        INSERT INTO analysis_tasks (id, task_type, entity_type, entity_id, status, input_hash,
          input_snapshot_json, started_at, created_at, updated_at)
        VALUES ('bad-task', 'job_match_analysis', 'x', 'y', 'queued', 'h', '{}', 100, 100, 100)
      `).run(),
    ).toThrow(/CHECK constraint failed/);
  });
});

function insertResumeVersionFixture(db: SqliteDatabase, id: string): void {
  db.prepare(`
    INSERT INTO resume_versions (id, name, source, content_hash, summary, content_json, created_at, archived_at, row_version, idempotency_key, request_hash)
    VALUES (?, 'resume', 'pasted_text', 'rhash', 'summary', '{}', 100, NULL, 1, ?, 'rq')
  `).run(id, `idem-${id}`);
}

describe('AnalysisRecordRepository', () => {
  it('round-trips a record and enforces input_hash uniqueness', () => {
    insertCandidateWithVersion(db, 'cand-a1', 'ver-a1');
    insertResumeVersionFixture(db, 'resume-a1');
    const repo = new AnalysisRecordRepository(db);
    const record = {
      id: 'record-1', candidateId: 'cand-a1', candidateVersionId: 'ver-a1',
      resumeVersionId: 'resume-a1', jobMatchProfileVersionId: 'profile-v1', cityCode: 'sz',
      capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
      ruleVersion: 'rules-v1', promptVersion: 'prompt-v1', analysisPolicyVersion: 'policy-v1',
      modelProvider: 'openai', modelName: 'gpt', modelVersion: null, inputHash: 'input-hash-1',
      recommendation: 'apply_now' as const, confidence: 'high' as const, payload: { ok: true },
      createdAt: 100, supersedesAnalysisId: null,
    };
    repo.insert(record);
    expect(repo.findByInputHash('input-hash-1')?.id).toBe('record-1');
    expect(() => repo.insert({ ...record, id: 'record-2' })).toThrow();
    expect(repo.listByCandidate('cand-a1')).toHaveLength(1);
  });
});

describe('RadarRecommendationBatchRepository', () => {
  it('round-trips a batch and enforces batch_key uniqueness', () => {
    const repo = new RadarRecommendationBatchRepository(db);
    const batch = {
      id: 'batch-1', batchKey: 'batch-key-1', status: 'succeeded' as const, scope: {},
      candidateVersionIds: ['ver-a1'], selectedCandidateVersionIds: ['ver-a1'], profileVersions: {},
      ruleVersion: 'rules-v1', recommendationRuleVersion: 'rec-rules-v1', analysisPolicyVersion: 'policy-v1',
      handledStateHash: 'handled-1', diagnosisStatus: 'formed' as const, diagnosisPayload: null,
      emptyReason: null, generatedAt: 100, createdAt: 100,
    };
    repo.insert(batch);
    expect(repo.findByBatchKey('batch-key-1')?.id).toBe('batch-1');
    expect(() => repo.insert({ ...batch, id: 'batch-2' })).toThrow();
  });
});

describe('RadarActionRepository and RadarPromotionRepository', () => {
  it('appends actions, supports revert linkage, and enforces promotion type consistency', () => {
    insertCandidateWithVersion(db, 'cand-p1', 'ver-p1');
    db.prepare(`INSERT INTO jobs (id, company, role, city, updated_at, created_at, data_json) VALUES ('job-1','Acme','Eng','sz',100,100,'{}')`).run();

    const actions = new RadarActionRepository(db);
    actions.insert({
      id: 'action-1', candidateId: 'cand-p1', candidateVersionId: 'ver-p1', actionType: 'saved',
      reasonCode: null, reasonText: null, metadata: {}, occurredAt: 100, revertedByActionId: null, createdAt: 100,
    });
    actions.insert({
      id: 'action-2', candidateId: 'cand-p1', candidateVersionId: 'ver-p1', actionType: 'unsaved',
      reasonCode: null, reasonText: null, metadata: {}, occurredAt: 110, revertedByActionId: null, createdAt: 110,
    });
    expect(actions.markReverted('action-1', 'action-2')).toBe(true);
    expect(actions.getById('action-1')?.revertedByActionId).toBe('action-2');
    expect(actions.listByCandidate('cand-p1')).toHaveLength(2);

    const promotions = new RadarPromotionRepository(db);
    promotions.insert({
      id: 'promo-1', candidateId: 'cand-p1', candidateVersionId: 'ver-p1', promotionType: 'job_only',
      jobId: 'job-1', applicationId: null, feedbackEventId: null, triggerActionId: 'action-2',
      idempotencyKey: 'idem-promo-1', createdAt: 120,
    });
    expect(promotions.findByIdempotencyKey('idem-promo-1')?.id).toBe('promo-1');
    expect(() =>
      db.prepare(`
        INSERT INTO radar_promotions (id, candidate_id, candidate_version_id, promotion_type, job_id, idempotency_key, created_at)
        VALUES ('promo-2', 'cand-p1', 'ver-p1', 'application', 'job-1', 'idem-promo-2', 120)
      `).run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
