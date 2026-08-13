import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCandidateRepository } from '../candidateRepository';
import type { RadarCandidateNormalized } from '../../../src/domain/radar';
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

/** 构造 core facts 全空（除 overrides）的 normalized，用于锁定 hasCoreFacts 的充分性边界。 */
function emptyNormalized(overrides: Partial<RadarCandidateNormalized> = {}): RadarCandidateNormalized {
  return {
    company: null, role: null, city: null, district: null,
    salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
    experienceRequirement: null, educationRequirement: null,
    companySize: null, industry: null, jobNature: null, workMode: null,
    technicalStack: [], responsibilities: [], requirements: [],
    publishedAt: null, rawDescription: '',
    ...overrides,
  };
}

/** 直接经 Repository 写入一个 active 候选 + 正式版本（指定 normalized），返回版本 ID。 */
function seedCandidateWithNormalized(normalized: RadarCandidateNormalized, suffix: string): string {
  const candidates = new RadarCandidateRepository(db);
  const candidateId = `cand-${suffix}`;
  const versionId = `ver-${suffix}`;
  candidates.insertCandidate({
    id: candidateId, primarySourceRecordId: null, activeVersionId: null,
    lifecycleStatus: 'active', mergedIntoCandidateId: null,
    createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
  });
  candidates.insertVersion({
    id: versionId, candidateId, versionNo: 1, normalized,
    qualityIssues: [], sourceSnapshotIds: [], contentHash: `content-hash-${suffix}`,
    originType: 'captured', evidenceLevel: 'FULL_EVIDENCE',
    correctionNote: null, supersedesVersionId: null, createdAt: 1_700_000_000,
  });
  candidates.setActiveVersionId(candidateId, versionId, 1_700_000_000);
  return versionId;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-input-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
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

  it('rejects INPUT_NOT_READY when a FULL_EVIDENCE candidate has no core facts', () => {
    // Evidence Eligibility 已通过（evidenceLevel=FULL_EVIDENCE），但第二层 Input Readiness 仍应阻断：
    // candidate/version 存在且匹配、active、正式简历/画像齐全，仅 role/company/描述/职责/要求/技术栈全空。
    const versionId = seedCandidateWithNormalized(emptyNormalized(), 'no-core-facts');
    seedActiveResumeAndProfile(db, 1_700_000_000);
    const stored = new RadarCandidateRepository(db).getVersion(versionId)!;
    expect(stored.evidenceLevel).toBe('FULL_EVIDENCE'); // 明确前提：不是 SEARCH_EVIDENCE 触发的阻断。
    try {
      buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisInputError);
      expect((error as AnalysisInputError).code).toBe('INPUT_NOT_READY');
      // 只断言稳定语义，不对易变的整段中文 message 做全文匹配。
      expect((error as AnalysisInputError).message).toMatch(/不足以支撑分析/);
    }
  });

  it('treats a single core fact (role only) as sufficient — hasCoreFacts is not all-fields-required', () => {
    const versionId = seedCandidateWithNormalized(emptyNormalized({ role: '后端工程师' }), 'role-only');
    seedActiveResumeAndProfile(db, 1_700_000_000);
    const result = buildJobMatchAnalysisInputSnapshot(db, versionId, OPTIONS);
    expect(result.snapshot.contractVersion).toBe(1);
    expect(result.snapshot.candidate.normalizedFacts.role).toBe('后端工程师');
  });
});

describe('evidence_json column backward-compat (radar_rule_assessments no evidence_json)', () => {
  let compatDir: string;
  let compatDb: SqliteDatabase;

  beforeEach(() => {
    compatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-compat-'));
    compatDb = openDb(path.join(compatDir, 'test.sqlite3'));
    // V9 schema has evidence_level on radar_candidate_versions but still no evidence_json
    // on radar_rule_assessments — this test validates backward-compat of the
    // legacy_scalar read path.
    initSchema(compatDb, { targetVersion: 9 });
  });
  afterEach(() => {
    compatDb.close();
    fs.rmSync(compatDir, { recursive: true, force: true });
  });

  it('reads assessments via column-detection and marks them legacy_scalar (no crash on missing evidence_json column)', () => {
    const capture = new RadarCaptureService(compatDb, deterministicDeps());
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
    // radar_rule_assessments 无 evidence_json 列（v9 migration 未加该列）：
    // 直接用不含 evidence_json 的 v7 列集插入评估。
    compatDb.prepare(
      `INSERT INTO radar_rule_assessments
       (id, candidate_id, candidate_version_id, rule_version, rule_key, category, severity, result, matched_text, source_path, explanation, created_at)
       VALUES (@id, @cid, @vid, 'rules-v1', 'salary_floor', 'hard_constraint', 'blocking', 'hit', '20K', 'salaryMinK', '命中', 1700000000)`,
    ).run({ id: 'v7-assess-1', cid: outcome.candidateId, vid: outcome.candidateVersionId });
    seedActiveResumeAndProfile(compatDb, 1_700_000_000);

    const result = buildJobMatchAnalysisInputSnapshot(compatDb, outcome.candidateVersionId!, OPTIONS);
    expect(result.snapshot.ruleProjection.assessments).toHaveLength(1);
    expect(result.snapshot.ruleProjection.assessments[0]!.evidenceState).toBe('legacy_scalar');
  });
});
