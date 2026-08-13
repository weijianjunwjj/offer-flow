/**
 * V8-6 第二波 · 晋升 HTTP 接口测试。
 *
 * 覆盖：创建/幂等状态码、安全出参白名单、错误码映射、安全网关继承、schema 门禁。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { buildServer } from '../../index';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function headers(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}

let seq = 0;

function setup(targetVersion = 9): { app: FastifyInstance; db: SqliteDatabase } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-promo-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion });
  let clock = 1_800_000_000;
  const app = buildServer({
    db,
    radar: {
      enabled: true,
      promotionDeps: { now: () => (clock += 1), createId: () => `promo-${(seq += 1)}` },
    },
  });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { app, db };
}

function seedCandidate(db: SqliteDatabase, tag: string): { candidateId: string; versionId: string } {
  let s = 0;
  const capture = new RadarCaptureService(db, {
    now: () => 1_700_000_000 + s,
    createId: () => `cap-${tag}-${(s += 1)}`,
  });
  const session = capture.createSession({ sourceType: 'browser' });
  capture.addItem(session.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: `https://www.zhipin.com/job_detail/${tag}.html`, sourceDomain: 'zhipin.com',
    pageTitle: null, visibleText: `岗位：后端 @ 公司${tag} 苏州`, externalRecordId: tag,
    recognizedFields: {
      company: `公司${tag}`, role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(session.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  return { candidateId: outcome.candidateId!, versionId: outcome.candidateVersionId! };
}

async function post(app: FastifyInstance, url: string, body: unknown, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: headers(extra), payload: body as object });
}
async function get(app: FastifyInstance, url: string) {
  return app.inject({ method: 'GET', url, headers: headers() });
}

describe('晋升 HTTP — 创建与幂等', () => {
  it('首次晋升返回 201 与计划视图', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'h1');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, any>;
    expect(body.created).toBe(true);
    expect(body.promotion.promotionType).toBe('feedback');
    expect(body.plan.effectiveDepth).toBe('feedback');
    expect(body.plan.feedbackEventType).toBe('hr_replied');
  });

  it('重放返回 200 与同一晋升 id', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'h2');
    const payload = { trigger: 'hr_replied', requestedDepth: 'feedback' };

    const first = await post(app, `/radar/candidate-versions/${versionId}/promotions`, payload);
    const replay = await post(app, `/radar/candidate-versions/${versionId}/promotions`, payload);

    expect(replay.statusCode).toBe(200);
    expect((replay.json() as any).created).toBe(false);
    expect((replay.json() as any).promotion.id).toBe((first.json() as any).promotion.id);
    expect((replay.json() as any).plan.clampReasons).toContain('already_promoted');
  });

  it('出参不外泄 idempotencyKey 等内部键', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'h3');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    const body = res.json() as Record<string, any>;
    expect(body.promotion).not.toHaveProperty('idempotencyKey');
    expect(body.plan).not.toHaveProperty('idempotencyKey');
    expect(body.plan).not.toHaveProperty('targetScopeKey');
  });
});

describe('晋升 HTTP — 查询', () => {
  it('按 id 查询晋升记录', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'h4');
    const created = await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });
    const id = (created.json() as any).promotion.id;

    const res = await get(app, `/radar/promotions/${id}`);

    expect(res.statusCode).toBe(200);
    expect((res.json() as any).id).toBe(id);
  });

  it('晋升不存在时返回 404 PROMOTION_NOT_FOUND', async () => {
    const { app } = setup();
    const res = await get(app, '/radar/promotions/not-exist');
    expect(res.statusCode).toBe(404);
    expect((res.json() as any).code).toBe('PROMOTION_NOT_FOUND');
  });

  it('按候选列出晋升记录', async () => {
    const { app, db } = setup();
    const { candidateId, versionId } = seedCandidate(db, 'h5');
    await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    const res = await get(app, `/radar/candidates/${candidateId}/promotions`);

    expect(res.statusCode).toBe(200);
    expect((res.json() as any[]).length).toBe(1);
  });
});

describe('晋升 HTTP — 预览', () => {
  it('预览返回 200 与计划，且零写入', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'pr1');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions/preview`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.plan.effectiveDepth).toBe('feedback');
    expect(body.plan.feedbackEventType).toBe('hr_replied');
    // 预览绝不落库。
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_promotions').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n).toBe(0);
  });

  it('预览不返回 promotion，只返回 plan', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'pr2');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions/preview`, {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    const body = res.json() as any;
    expect(body).not.toHaveProperty('promotion');
    expect(body).not.toHaveProperty('created');
    expect(body.plan).not.toHaveProperty('idempotencyKey');
  });

  it('预览显示深度钳制原因', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'pr3');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions/preview`, {
      trigger: 'user_priority', requestedDepth: 'feedback',
    });

    const plan = (res.json() as any).plan;
    expect(plan.requestedDepth).toBe('feedback');
    expect(plan.effectiveDepth).toBe('job_only');
    expect(plan.clampReasons).toContain('trigger_forbids_application');
  });

  it('预览 no_response 返回 409，且零写入', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'pr4');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions/preview`, {
      trigger: 'no_response', requestedDepth: 'feedback',
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as any).code).toBe('PROMOTION_TRIGGER_NOT_ALLOWED');
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_promotions').get() as any).n).toBe(0);
  });

  it('预览后确认晋升：计划一致且正式对象落库', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'pr5');
    const payload = { trigger: 'hr_replied', requestedDepth: 'feedback' };

    const preview = await post(app, `/radar/candidate-versions/${versionId}/promotions/preview`, payload);
    const confirm = await post(app, `/radar/candidate-versions/${versionId}/promotions`, payload);

    expect(confirm.statusCode).toBe(201);
    expect((confirm.json() as any).plan.effectiveDepth).toBe((preview.json() as any).plan.effectiveDepth);
    expect((db.prepare('SELECT COUNT(*) AS n FROM radar_promotions').get() as any).n).toBe(1);
  });
});

describe('晋升 HTTP — 错误码映射与安全', () => {
  it('no_response 返回 409 PROMOTION_TRIGGER_NOT_ALLOWED，且零写入', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'e1');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'no_response', requestedDepth: 'feedback',
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as any).code).toBe('PROMOTION_TRIGGER_NOT_ALLOWED');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM radar_promotions').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('候选版本不存在返回 404', async () => {
    const { app } = setup();
    const res = await post(app, '/radar/candidate-versions/nope/promotions', {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as any).code).toBe('CANDIDATE_VERSION_NOT_FOUND');
  });

  it('指认不存在的 jobId 返回 409 PROMOTION_TARGET_CONFLICT', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'e2');

    const res = await post(app, `/radar/candidate-versions/${versionId}/promotions`, {
      trigger: 'hr_replied', requestedDepth: 'feedback', jobId: 'job-nope',
    });

    expect(res.statusCode).toBe(409);
    expect((res.json() as any).code).toBe('PROMOTION_TARGET_CONFLICT');
  });

  it('非法入参返回 400，且拒绝未知字段', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'e3');
    const url = `/radar/candidate-versions/${versionId}/promotions`;

    expect((await post(app, url, { trigger: 'bogus', requestedDepth: 'feedback' })).statusCode).toBe(400);
    expect((await post(app, url, { trigger: 'hr_replied' })).statusCode).toBe(400);
    // 前端无权指定要写哪个事件类型：多余字段直接拒绝。
    expect((await post(app, url, {
      trigger: 'hr_replied', requestedDepth: 'feedback', feedbackEventType: 'rejected',
    })).statusCode).toBe(400);
  });

  it('缺少采集客户端请求头时被安全网关拒绝（继承父作用域网关）', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'e4');

    const res = await app.inject({
      method: 'POST',
      url: `/radar/candidate-versions/${versionId}/promotions`,
      payload: { trigger: 'hr_replied', requestedDepth: 'feedback' },
    });

    // 断言是被网关挡住（403），而非碰巧因入参/路由问题得到 4xx。
    expect(res.statusCode).toBe(403);
  });

  it('schema < v8 时不注册晋升路由', async () => {
    // V9 schema 引入了 evidence_level 列，因此 seedCandidate 在 v7 schema 无法使用。
    // 此测试通过在 v7 DB 上构建 server 并直接发起请求验证路由不注册，不注入 candidate。
    const { app } = setup(7);
    // 使用不存在的 versionId 发起请求——如果路由门禁生效，应返回 404（路由不存在）。
    // 如果路由绕过 schema 门禁注册，会返回领域层的 CANDIDATE_VERSION_NOT_FOUND。
    const res = await post(app, '/radar/candidate-versions/non-existent-id/promotions', {
      trigger: 'hr_replied', requestedDepth: 'feedback',
    });

    // 必须是"路由不存在"（Fastify 404），而不是领域层的 CANDIDATE_VERSION_NOT_FOUND——
    // 后者说明路由其实注册了，门禁没生效。
    expect(res.statusCode).toBe(404);
    expect((res.json() as any).code).not.toBe('CANDIDATE_VERSION_NOT_FOUND');
  });
});
