import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarRuleAssessmentRepository } from '../ruleAssessmentRepository';
import { AnalysisTaskRepository } from '../analysisTaskRepository';
import { ProfileRepository } from '../../repositories/profileRepository';
import { startTask } from './taskStateMachine';
import { seedReviewFixture } from '../reviewFixture';
import { seedActiveResumeAndProfile } from './analysisInputFixture';
import { AnalysisService } from './analysisService';
import {
  deterministicSuccessProvider,
  malformedThenRepairSuccessProvider,
  timeoutProvider,
  type CountingProvider,
} from './analysisProviderFakes';

let tempDir: string;
let db: SqliteDatabase;
let clock: number;
const now = (): number => (clock += 1);

function deterministicDeps() {
  let seq = 0;
  return { now: () => 1_700_000_000 + seq, createId: () => `id-${(seq += 1).toString().padStart(4, '0')}` };
}

/** v8 沙箱：seed 完整 review fixture + 正式简历/画像；返回目标候选当前正式版本 ID 与候选 ID。 */
function setup(): { versionId: string; candidateId: string } {
  const fixture = seedReviewFixture(db, deterministicDeps());
  seedActiveResumeAndProfile(db, 1_700_000_000);
  return { versionId: fixture.evidenceVersionId, candidateId: fixture.materialCandidateId };
}

/** 构造服务：注入 fake provider + 单调时钟 + 确定性 record id（绝不读真实环境变量）。 */
function makeService(provider: CountingProvider): { service: AnalysisService; provider: CountingProvider } {
  let seq = 0;
  const service = new AnalysisService({ db, provider, now, createRecordId: () => `rec-${(seq += 1)}` });
  return { service, provider };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-service-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 8 });
  clock = 1_700_000_000;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('createTask — 固定输入 / 幂等 / 不调用 Provider', () => {
  it('creates a queued task (attemptCount=0) without calling the provider', () => {
    const { versionId } = setup();
    const { service, provider } = makeService(deterministicSuccessProvider());
    const { task, created } = service.createTask(versionId);
    expect(created).toBe(true);
    expect(task.status).toBe('queued');
    expect(task.attemptCount).toBe(0);
    expect(task.entityId).toBe(versionId);
    expect(provider.counts.generate).toBe(0);
    expect(provider.counts.repair).toBe(0);
  });

  it('is idempotent: same fixed input returns the existing task', () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const first = service.createTask(versionId);
    const second = service.createTask(versionId);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM analysis_tasks').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('returns a cancelled task unchanged when input is unchanged (no auto rerun)', () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    service.cancelTask(task.id);
    const again = service.createTask(versionId);
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(task.id);
    expect(again.task.status).toBe('cancelled');
  });
});

describe('runTask — 编排 / 不可变记录 / supersedes', () => {
  it('runs a queued task to success and writes an immutable record', async () => {
    const { versionId } = setup();
    const { service, provider } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    const outcome = await service.runTask(task.id);
    expect(outcome.kind).toBe('succeeded');
    expect(provider.counts.generate).toBe(1);
    const done = service.getTask(task.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.resultRecordId).not.toBeNull();
    expect(service.getAnalysis(done.resultRecordId!)).not.toBeNull();
  });

  it('record carries recommendation / confidence / payload from the parsed payload', async () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    await service.runTask(task.id);
    const record = service.getAnalysis(service.getTask(task.id)!.resultRecordId!)!;
    expect(record.recommendation).toBe('verify');
    expect(record.confidence).toBe('low');
    expect(record.cityCode).toBe('suzhou'); // 苏州 → 归一化 code
    expect((record.payload as { contractVersion: number }).contractVersion).toBe(1);
    expect(record.modelProvider).toBe('fake');
  });

  it('malformed → one repair → succeeded (at most two model calls)', async () => {
    const { versionId } = setup();
    const { service, provider } = makeService(malformedThenRepairSuccessProvider());
    const { task } = service.createTask(versionId);
    const outcome = await service.runTask(task.id);
    expect(outcome.kind).toBe('succeeded');
    expect(provider.counts.generate).toBe(1);
    expect(provider.counts.repair).toBe(1);
  });

  it('provider timeout maps to a failed task with no record', async () => {
    const { versionId } = setup();
    const { service } = makeService(timeoutProvider());
    const { task } = service.createTask(versionId);
    const outcome = await service.runTask(task.id);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.errorCode).toBe('PROVIDER_TIMEOUT');
    expect(service.getTask(task.id)!.resultRecordId).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM job_match_analysis_records').get() as { n: number }).n).toBe(0);
  });
});

describe('supersedesAnalysisId — 链接旧记录，不 UPDATE', () => {
  it('links the second analysis to the prior latest record; the old record is untouched', async () => {
    const { versionId, candidateId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const first = service.createTask(versionId);
    await service.runTask(first.task.id);
    const rec1Id = service.getTask(first.task.id)!.resultRecordId!;

    // 追加一条评估 → 改变 ruleProjection → 新 inputHash → 同候选第二条记录。
    new RadarRuleAssessmentRepository(db).insert({
      id: 'extra-assess-1', candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v2',
      ruleKey: 'extra_rule', category: 'risk', severity: 'warn', result: 'hit',
      matchedText: null, sourcePath: null, explanation: '追加评估以改变输入指纹',
      evidenceJson: null, createdAt: now(),
    });
    const second = service.createTask(versionId);
    expect(second.task.id).not.toBe(first.task.id); // inputHash 不同 → 新任务。
    await service.runTask(second.task.id);
    const rec2 = service.getAnalysis(service.getTask(second.task.id)!.resultRecordId!)!;

    expect(rec2.supersedesAnalysisId).toBe(rec1Id);
    expect(service.getAnalysis(rec1Id)!.supersedesAnalysisId).toBeNull(); // 旧记录未被改写。
  });
});

describe('retry / cancel / recovery', () => {
  it('failed retry reuses the original snapshot and does not run until runTask', async () => {
    const { versionId } = setup();
    const { service, provider } = makeService(timeoutProvider());
    const { task } = service.createTask(versionId);
    const originalSnapshot = service.getTask(task.id)!.inputSnapshot;
    await service.runTask(task.id); // → failed
    expect(service.getTask(task.id)!.status).toBe('failed');

    const requeued = service.retryTask(task.id);
    expect(requeued.status).toBe('queued');
    expect(requeued.attemptCount).toBe(1); // retry 不递增
    expect(requeued.inputSnapshot).toEqual(originalSnapshot); // 复用原快照
    expect(provider.counts.generate).toBe(1); // retry 未再次调用 Provider
  });

  it('cancelled task cannot be retried', async () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    service.cancelTask(task.id);
    expect(() => service.retryTask(task.id)).toThrow();
  });

  it('cancel lands a queued task in cancelled', () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    expect(service.cancelTask(task.id).status).toBe('cancelled');
  });

  it('recoverOnStartup marks orphaned running as failed(PROCESS_RESTART_INTERRUPTED)', () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    // 手工把任务推进到 running（模拟进程崩溃前）。
    const tasks = new AnalysisTaskRepository(db);
    tasks.transition({ taskId: task.id, expectedStatus: 'queued', next: startTask(tasks.getById(task.id)!, { now: now() }) });
    const { interrupted } = service.recoverOnStartup();
    expect(interrupted).toEqual([task.id]);
    expect(service.getTask(task.id)!.errorCode).toBe('PROCESS_RESTART_INTERRUPTED');
  });
});

describe('listCandidateAnalyses — 有效性投影（派生，不新增字段）', () => {
  it('reports current right after a successful run', async () => {
    const { versionId, candidateId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    await service.runTask(task.id);
    const views = service.listCandidateAnalyses(candidateId);
    expect(views).toHaveLength(1);
    expect(views[0]!.validity.status).toBe('current');
    expect(views[0]!.validity.staleReasons).toEqual([]);
  });

  it('becomes stale after the candidate active version changes', async () => {
    const { versionId, candidateId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    await service.runTask(task.id);

    // 新增候选版本并置为 active → 记录冻结的 candidateVersionId 不再匹配。
    const later = 1_800_000_000; // 大于 fixture 独立时钟写入的 created_at，满足 updated_at>=created_at CHECK。
    db.prepare(`INSERT INTO radar_candidate_versions
      (id, candidate_id, version_no, normalized_json, quality_issues_json, source_snapshot_ids_json, content_hash, origin_type, created_at)
      VALUES ('cv-next', ?, 99, '{}', '[]', '[]', 'ch-next', 'captured', ?)`).run(candidateId, later);
    new RadarCandidateRepository(db).setActiveVersionId(candidateId, 'cv-next', later);

    const view = service.listCandidateAnalyses(candidateId)[0]!;
    expect(view.validity.status).toBe('stale');
    expect(view.validity.staleReasons).toContain('candidate_version_changed');
  });

  it('becomes stale after the active job-match profile version changes', async () => {
    const { versionId, candidateId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const { task } = service.createTask(versionId);
    await service.runTask(task.id);

    // 直接改当前正式画像的 activeVersionId（模拟 profile re-version）→ job_match_profile_changed。
    const profile = new ProfileRepository(db).get()!;
    (profile.jobMatchProfile as { activeVersionId: string }).activeVersionId = 'jmp-ver-2';
    db.prepare('UPDATE profiles SET data_json = ? WHERE id = ?').run(JSON.stringify(profile), 'default');

    const view = service.listCandidateAnalyses(candidateId)[0]!;
    expect(view.validity.status).toBe('stale');
    expect(view.validity.staleReasons).toContain('job_match_profile_changed');
  });
});

describe('边界 — 不创建 Job / Application / FeedbackEvent', () => {
  it('creating and running a task adds zero rows to job/application/feedback tables', async () => {
    const { versionId } = setup();
    const { service } = makeService(deterministicSuccessProvider());
    const before = counts();
    const { task } = service.createTask(versionId);
    await service.runTask(task.id);
    expect(counts()).toEqual(before);
  });
});

/** 三张不应被分析编排触碰的表的行数快照。 */
function counts(): { jobs: number; applications: number; feedback: number } {
  const n = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { jobs: n('jobs'), applications: n('applications'), feedback: n('feedback_events') };
}
