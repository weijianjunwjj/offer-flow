import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { buildServer } from '../../index';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';
import { RadarCandidateRepository } from '../candidateRepository';
import { seedActiveResumeAndProfile } from './analysisInputFixture';
import {
  deterministicSuccessProvider,
  timeoutProvider,
  delayedCancellableProvider,
  malformedThenRepairFailureProvider,
  type CountingProvider,
} from './analysisProviderFakes';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => void> = [];

function headers(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}

/** 采集桥确定性依赖（v7 建候选用）。 */
function captureDeps() {
  let seq = 0;
  return { now: () => 1_700_000_000 + seq, createId: () => `cap-${(seq += 1)}` };
}

/** 经 v7 采集桥落一个真实候选 + 正式版本（不依赖 v8 评审 fixture）。 */
function seedCandidate(db: SqliteDatabase): { candidateId: string; versionId: string } {
  const capture = new RadarCaptureService(db, captureDeps());
  const s = capture.createSession({ sourceType: 'browser' });
  capture.addItem(s.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: 'https://www.zhipin.com/job_detail/analysis-1.html', sourceDomain: 'zhipin.com', pageTitle: null,
    visibleText: '岗位描述：后端工程师 @ 越迁软件，工作地 苏州。', externalRecordId: 'analysis-1',
    recognizedFields: {
      company: '越迁软件', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  return { candidateId: outcome.candidateId!, versionId: outcome.candidateVersionId! };
}

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
  candidateId: string;
  versionId: string;
}

/** v7 沙箱 + 注入 fake provider + 单调时钟 + 确定性 record id（禁止读真实 key / 访问外网）。 */
function setup(
  provider: CountingProvider,
  opts: { analysisEnabled?: boolean; seedResumeProfile?: boolean } = {},
): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-analysis-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 7 });
  const { candidateId, versionId } = seedCandidate(db);
  if (opts.seedResumeProfile !== false) seedActiveResumeAndProfile(db, 1_700_000_000);
  let recSeq = 0;
  let clock = 1_800_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      analysisEnabled: opts.analysisEnabled ?? true,
      serviceDeps: captureDeps(),
      analysisDeps: { provider, now: () => (clock += 1), createRecordId: () => `rec-${(recSeq += 1)}` },
    },
  });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { app, db, candidateId, versionId };
}

afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function post(app: FastifyInstance, url: string, extraHeaders: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: headers(extraHeaders), payload: {} });
}
async function get(app: FastifyInstance, url: string) {
  return app.inject({ method: 'GET', url, headers: headers() });
}
async function createTask(h: Harness): Promise<{ id: string; status: string }> {
  const res = await post(h.app, `/radar/candidate-versions/${h.versionId}/analysis-tasks`);
  expect(res.statusCode).toBe(200);
  return res.json() as { id: string; status: string };
}

describe('创建任务 — 幂等 / 不调用 Provider / 安全出参', () => {
  it('creates a queued task (attemptCount=0) and returns a safe Task View', async () => {
    const h = setup(deterministicSuccessProvider());
    const res = await post(h.app, `/radar/candidate-versions/${h.versionId}/analysis-tasks`);
    expect(res.statusCode).toBe(200);
    const view = res.json() as Record<string, unknown>;
    expect(view.status).toBe('queued');
    expect(view.attemptCount).toBe(0);
    expect(view.entityId).toBe(h.versionId);
    // 严格白名单：绝不外泄 inputSnapshot / inputHash。
    expect(view).not.toHaveProperty('inputSnapshot');
    expect(view).not.toHaveProperty('inputHash');
  });

  it('is idempotent: same input returns the same task id', async () => {
    const h = setup(deterministicSuccessProvider());
    const first = await createTask(h);
    const second = await createTask(h);
    expect(second.id).toBe(first.id);
    expect((h.db.prepare('SELECT COUNT(*) c FROM analysis_tasks').get() as { c: number }).c).toBe(1);
  });

  it('create does not call the provider', async () => {
    const provider = deterministicSuccessProvider();
    const h = setup(provider);
    await createTask(h);
    expect(provider.counts.generate).toBe(0);
    expect(provider.counts.repair).toBe(0);
  });

  it('cancelled task with unchanged input is returned as-is (no auto rerun)', async () => {
    const h = setup(deterministicSuccessProvider());
    const created = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${created.id}/cancel`);
    const again = await createTask(h);
    expect(again.id).toBe(created.id);
    expect(again.status).toBe('cancelled');
  });
});

describe('执行 / 查询', () => {
  it('run drives a queued task to succeeded (schema v7)', async () => {
    const provider = deterministicSuccessProvider();
    const h = setup(provider);
    const task = await createTask(h);
    const run = await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    expect(run.statusCode).toBe(200);
    expect((run.json() as { status: string }).status).toBe('succeeded');
    expect(provider.counts.generate).toBe(1);
  });

  it('GET task can be polled after run', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    const res = await get(h.app, `/radar/analysis-tasks/${task.id}`);
    expect(res.statusCode).toBe(200);
    const view = res.json() as { status: string; resultRecordId: string | null };
    expect(view.status).toBe('succeeded');
    expect(view.resultRecordId).not.toBeNull();
  });

  it('GET analysis returns result with envelope + validity, no sensitive fields', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    const taskView = (await get(h.app, `/radar/analysis-tasks/${task.id}`)).json() as { resultRecordId: string };
    const res = await get(h.app, `/radar/analyses/${taskView.resultRecordId}`);
    expect(res.statusCode).toBe(200);
    const view = res.json() as Record<string, unknown>;
    expect(view.recommendation).toBe('verify');
    expect(view.confidence).toBe('low');
    expect(view.cityCode).toBe('suzhou');
    expect((view.validity as { status: string }).status).toBe('current');
    const serialized = JSON.stringify(view);
    for (const forbidden of ['inputSnapshot', 'visibleText', 'securityId', 'cookie', 'token', 'apiKey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('GET candidate analyses returns history + validity projection', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    const res = await get(h.app, `/radar/candidates/${h.candidateId}/analyses`);
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ validity: { status: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.validity.status).toBe('current');
  });
});

describe('retry / cancel 状态机', () => {
  it('failed → retry → queued (does not run until run is called)', async () => {
    const provider = timeoutProvider();
    const h = setup(provider);
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`); // → failed
    expect((await get(h.app, `/radar/analysis-tasks/${task.id}`)).json()).toMatchObject({ status: 'failed' });
    const retry = await post(h.app, `/radar/analysis-tasks/${task.id}/retry`);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { status: string }).status).toBe('queued');
    expect(provider.counts.generate).toBe(1); // retry 未再次调用 Provider
  });

  it('queued task can be cancelled', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    const res = await post(h.app, `/radar/analysis-tasks/${task.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('cancelled');
  });

  it('running task can be cancelled', async () => {
    const h = setup(delayedCancellableProvider());
    const task = await createTask(h);
    const runP = post(h.app, `/radar/analysis-tasks/${task.id}/run`); // 不 await：停在 running
    await new Promise((r) => setTimeout(r, 30));
    const cancel = await post(h.app, `/radar/analysis-tasks/${task.id}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as { status: string }).status).toBe('cancelled');
    await runP;
  });

  it('cancelled task cannot be retried (409)', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/cancel`);
    const res = await post(h.app, `/radar/analysis-tasks/${task.id}/retry`);
    expect(res.statusCode).toBe(409);
  });

  it('manual retry survives past the auto budget and only 409s at the hard ceiling', async () => {
    const h = setup(timeoutProvider()); // maxAttempts=3；人工硬上限=6（MANUAL_RETRY_ATTEMPT_CEILING）
    const task = await createTask(h);
    // 连续执行 6 次（每次 failed 后人工重新分析）：越过自动预算 3，仍应放行直到累计 6 次。
    for (let i = 0; i < 6; i += 1) {
      await post(h.app, `/radar/analysis-tasks/${task.id}/run`); // → failed
      if (i < 5) {
        const retry = await post(h.app, `/radar/analysis-tasks/${task.id}/retry`);
        expect(retry.statusCode).toBe(200); // 含 attemptCount=3/4/5 这些越预算但未达上限的情形
        expect((retry.json() as { status: string }).status).toBe('queued');
      }
    }
    const view = (await get(h.app, `/radar/analysis-tasks/${task.id}`)).json() as { attemptCount: number };
    expect(view.attemptCount).toBe(6); // 历史保留累加，不清零
    const exhausted = await post(h.app, `/radar/analysis-tasks/${task.id}/retry`);
    expect(exhausted.statusCode).toBe(409); // 触及硬上限，杜绝无限重试
  });

  it('failure error_message carries the specific validation summary (not a generic string)', async () => {
    const h = setup(malformedThenRepairFailureProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`); // 首答坏 + 修复仍坏 → failed
    const view = (await get(h.app, `/radar/analysis-tasks/${task.id}`)).json() as {
      status: string; errorCode: string; errorMessage: string;
    };
    expect(view.status).toBe('failed');
    expect(view.errorCode).toBe('STRUCTURE_REPAIR_FAILED');
    // 具体摘要而非泛化：至少含结构错误码定位信息，且绝不泄漏 rawText。
    expect(view.errorMessage).toContain('ANALYSIS_JSON_INVALID');
    expect(view.errorMessage).not.toContain('坏的两次');
  });
});

describe('有效性 / 就绪性 / 门禁 / 边界', () => {
  it('analyses become stale after the candidate active version changes', async () => {
    const h = setup(deterministicSuccessProvider());
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    const later = 1_900_000_000; // 大于采集写入的 created_at，满足 updated_at>=created_at CHECK。
    h.db.prepare(`INSERT INTO radar_candidate_versions
      (id, candidate_id, version_no, normalized_json, quality_issues_json, source_snapshot_ids_json, content_hash, origin_type, created_at)
      VALUES ('cv-next', ?, 99, '{}', '[]', '[]', 'ch-next', 'captured', ?)`).run(h.candidateId, later);
    new RadarCandidateRepository(h.db).setActiveVersionId(h.candidateId, 'cv-next', later);
    const items = (await get(h.app, `/radar/candidates/${h.candidateId}/analyses`)).json() as
      Array<{ validity: { status: string; staleReasons: string[] } }>;
    expect(items[0]!.validity.status).toBe('stale');
    expect(items[0]!.validity.staleReasons).toContain('candidate_version_changed');
  });

  it('create returns 422 when active resume/profile is missing', async () => {
    const h = setup(deterministicSuccessProvider(), { seedResumeProfile: false });
    const res = await post(h.app, `/radar/candidate-versions/${h.versionId}/analysis-tasks`);
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toMatch(/ACTIVE_(RESUME|PROFILE)_REQUIRED/);
  });

  it('rejects requests missing the capture-client header (403)', async () => {
    const h = setup(deterministicSuccessProvider());
    const res = await h.app.inject({
      method: 'POST', url: `/radar/candidate-versions/${h.versionId}/analysis-tasks`, payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('is unreachable (404) when analysisEnabled is false', async () => {
    const h = setup(deterministicSuccessProvider(), { analysisEnabled: false });
    const res = await post(h.app, `/radar/candidate-versions/${h.versionId}/analysis-tasks`);
    expect(res.statusCode).toBe(404);
  });

  it('create + run add zero rows to jobs / applications / feedback_events', async () => {
    const h = setup(deterministicSuccessProvider());
    const c = () => ({
      jobs: (h.db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c,
      apps: (h.db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c,
      fb: (h.db.prepare('SELECT COUNT(*) c FROM feedback_events').get() as { c: number }).c,
    });
    const before = c();
    const task = await createTask(h);
    await post(h.app, `/radar/analysis-tasks/${task.id}/run`);
    expect(c()).toEqual(before);
  });
});
