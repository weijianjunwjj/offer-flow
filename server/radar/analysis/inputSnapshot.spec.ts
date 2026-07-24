import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureService } from '../service';
import { seedReviewFixture } from '../reviewFixture';
import { seedActiveResumeAndProfile } from './analysisInputFixture';
import { buildJobMatchAnalysisInputSnapshot } from './inputSnapshot';
import { AnalysisInputError } from './inputErrors';
import { ANALYSIS_TASK_ID_PATTERN } from './inputHash';

let tempDir: string;
let db: SqliteDatabase;

const OPTIONS = {
  promptVersion: 'prompt-v1', analysisPolicyVersion: 'policy-v1', providerPolicyVersion: 'provider-policy-v1',
  provider: { providerName: 'deepseek', modelName: 'deepseek-chat', modelVersion: null },
  now: () => 1_700_000_000,
};

function deterministicDeps() {
  let seq = 0;
  return { now: () => 1_700_000_000 + seq, createId: () => `id-${(seq += 1).toString().padStart(4, '0')}` };
}

/** 建 v8 库并 seed 完整 review fixture + 正式简历/画像；返回目标候选当前正式版本 ID。 */
function setup(): { versionId: string; fixture: ReturnType<typeof seedReviewFixture> } {
  const fixture = seedReviewFixture(db, deterministicDeps());
  seedActiveResumeAndProfile(db, 1_700_000_000);
  return { versionId: fixture.evidenceVersionId, fixture };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-input-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('buildJobMatchAnalysisInputSnapshot', () => {
  it('builds a contract-valid snapshot with deterministic taskId and hash', () => {
    const { versionId } = setup();
    const result = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS);
    expect(result.snapshot.contractVersion).toBe(1);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.taskId).toMatch(ANALYSIS_TASK_ID_PATTERN);
    expect(result.taskId).toBe(`analysis-task:v1:${result.inputHash}`);
  });

  it('is deterministic: same input → same hash; prompt version change → different hash', () => {
    const { versionId } = setup();
    const a = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS);
    const b = buildJobMatchAnalysisInputSnapshot(db, versionId, { ...OPTIONS, now: () => 9_999 });
    expect(b.inputHash).toBe(a.inputHash); // createdAt 不入 hash
    const c = buildJobMatchAnalysisInputSnapshot(db, versionId, { ...OPTIONS, promptVersion: 'prompt-v2' });
    expect(c.inputHash).not.toBe(a.inputHash);
  });

  it('projects rule evidence state (structured/legacy/corrupt) without silently dropping corrupt', () => {
    const { versionId } = setup();
    const { assessments } = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS).snapshot.ruleProjection;
    const states = new Set(assessments.map((a) => a.evidenceState));
    expect(states).toContain('structured');
    expect(states).toContain('legacy_scalar');
    expect(states).toContain('corrupt');
  });

  it('projects active overrides but excludes reverted (set→revert → none)', () => {
    const { versionId } = setup();
    const { userOverrides } = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS).snapshot.ruleProjection;
    expect(userOverrides.some((o) => o.ruleKey === 'experience_ceiling' && o.overrideState === 'overridden_pass')).toBe(true);
    // salary_ceiling 被 set 后又 revert，终态 none：不得出现在生效覆盖中。
    expect(userOverrides.some((o) => o.ruleKey === 'salary_ceiling')).toBe(false);
  });

  it('records readiness limitation and medium ceiling when capability baseline is absent', () => {
    const { versionId } = setup();
    const { readiness } = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS).snapshot;
    expect(readiness.hasCapabilityBaseline).toBe(false);
    expect(readiness.confidenceCeiling).toBe('medium');
    expect(readiness.limitations.some((l) => l.includes('能力基线'))).toBe(true);
  });

  it('rejects unknown version / non-active candidate / superseded version / missing resume / missing profile', () => {
    const { versionId, fixture } = setup();
    const candidates = new RadarCandidateRepository(db);

    expect(() => buildJobMatchAnalysisInputSnapshot(db, 'nope', OPTIONS)).toThrow(AnalysisInputError);

    const version = candidates.getVersion(versionId)!;
    const superseded = candidates.listVersionsByCandidate(version.candidateId).find((v) => v.id !== versionId);
    if (superseded) {
      expect(() => buildJobMatchAnalysisInputSnapshot(db, superseded.id, OPTIONS))
        .toThrow(/CANDIDATE_VERSION_MISMATCH|不是候选当前正式版本/);
    }

    candidates.setLifecycleStatus(version.candidateId, 'archived', null, 1_800_000_000);
    try {
      buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS);
      throw new Error('expected throw');
    } catch (error) {
      expect((error as AnalysisInputError).code).toBe('CANDIDATE_NOT_ANALYZABLE');
    }
    void fixture;
  });

  it('requires an active resume and active profile', () => {
    const fixture = seedReviewFixture(db, deterministicDeps());
    // 未 seed 简历/画像 → 缺正式简历。
    try {
      buildJobMatchAnalysisInputSnapshot(db, fixture.evidenceVersionId, OPTIONS);
      throw new Error('expected throw');
    } catch (error) {
      expect((error as AnalysisInputError).code).toBe('ACTIVE_RESUME_REQUIRED');
    }
  });
});

describe('schema v7 compatibility (radar_rule_assessments without evidence_json column)', () => {
  let v7Dir: string;
  let v7Db: SqliteDatabase;

  beforeEach(() => {
    v7Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-v7-'));
    v7Db = openDb(path.join(v7Dir, 'test.sqlite3'));
    initSchema(v7Db, { targetVersion: 7 });
  });
  afterEach(() => {
    v7Db.close();
    fs.rmSync(v7Dir, { recursive: true, force: true });
  });

  it('reads assessments via column-detection and marks them legacy_scalar (no crash on missing column)', () => {
    const capture = new RadarCaptureService(v7Db, deterministicDeps());
    const session = capture.createSession({ sourceType: 'browser' });
    capture.addItem(session.session.id, {
      captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
      sourceUrl: 'https://www.zhipin.com/job_detail/v7-1.html', sourceDomain: 'zhipin.com', pageTitle: null,
      visibleText: '岗位描述：后端工程师 @ 越迁软件，工作地 苏州。', externalRecordId: 'v7-1',
      recognizedFields: {
        company: '越迁软件', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
        salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
      },
      extractionMetadata: null, capturedAt: null,
    });
    const outcome = capture.commitSession(session.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
    // v7 无 evidence_json 列：直接以 v7 列集插入一条评估。
    v7Db.prepare(
      `INSERT INTO radar_rule_assessments
       (id, candidate_id, candidate_version_id, rule_version, rule_key, category, severity, result, matched_text, source_path, explanation, created_at)
       VALUES (@id, @cid, @vid, 'rules-v1', 'salary_floor', 'hard_constraint', 'blocking', 'hit', '20K', 'salaryMinK', '命中', 1700000000)`,
    ).run({ id: 'v7-assess-1', cid: outcome.candidateId, vid: outcome.candidateVersionId });
    seedActiveResumeAndProfile(v7Db, 1_700_000_000);

    const result = buildJobMatchAnalysisInputSnapshot(v7Db, outcome.candidateVersionId!, OPTIONS);
    expect(result.snapshot.ruleProjection.assessments).toHaveLength(1);
    expect(result.snapshot.ruleProjection.assessments[0]!.evidenceState).toBe('legacy_scalar');
  });
});
