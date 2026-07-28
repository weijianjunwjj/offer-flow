/**
 * RC-11 反向追踪 HTTP 接口测试（第一波，只读）。
 *
 * 覆盖：安全网关继承（缺头 401）、schema 门禁（<v8 不注册）、
 * 晋升不存在 404、正式对象 traceable=true/false、"查不到来源"不报错而是合法追踪结论。
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

let seq = 0;

function setup(targetVersion = 8): { app: FastifyInstance; db: SqliteDatabase } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-trace-routes-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion });
  let clock = 1_800_000_000;
  const app = buildServer({
    db,
    radar: { enabled: true, promotionDeps: { now: () => (clock += 1), createId: () => `promo-${(seq += 1)}` } },
  });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { app, db };
}

function seedCandidate(db: SqliteDatabase, tag: string): { candidateId: string; versionId: string } {
  let s = 0;
  const capture = new RadarCaptureService(db, { now: () => 1_700_000_000 + s, createId: () => `cap-${tag}-${(s += 1)}` });
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

const H = { [CAPTURE_CLIENT_HEADER]: 'test-extension' };
const get = (app: FastifyInstance, url: string, headers: Record<string, string> = H) =>
  app.inject({ method: 'GET', url, headers });
const promote = (app: FastifyInstance, versionId: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/radar/candidate-versions/${versionId}/promotions`, headers: H, payload: body as object });

describe('RC-11 反向追踪 HTTP — 门禁与安全', () => {
  it('缺采集客户端头 → 复用安全网关拒绝（非 200）', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'g1');
    const { promotion } = (await promote(app, versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' })).json();
    const res = await get(app, `/radar/promotions/${promotion.id}/trace`, {});
    expect(res.statusCode).not.toBe(200);
  });

  it('schema < v8 → 追踪路由未注册（404）', async () => {
    const { app } = setup(7);
    const res = await get(app, '/radar/jobs/whatever/promotion-trace');
    expect(res.statusCode).toBe(404);
  });
});

describe('RC-11 反向追踪 HTTP — 追踪结论', () => {
  it('晋升不存在 → 404 PROMOTION_NOT_FOUND', async () => {
    const { app } = setup();
    const res = await get(app, '/radar/promotions/no-such/trace');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('PROMOTION_NOT_FOUND');
  });

  it('Job 有引用晋升 → 200 traceable=true，含候选版本与触发原因状态', async () => {
    const { app, db } = setup();
    const { versionId } = seedCandidate(db, 'g2');
    const { promotion } = (await promote(app, versionId, { trigger: 'hr_replied', requestedDepth: 'feedback' })).json();

    const res = await get(app, `/radar/jobs/${promotion.jobId}/promotion-trace`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.traceable).toBe(true);
    expect(body.promotions[0].promotionId).toBe(promotion.id);
    expect(body.promotions[0].candidateVersion.status).toBe('resolved');
    expect(body.promotions[0].trigger.status).toBe('not_recorded');
    expect(body.promotions[0].recommendationBatches.status).toBe('no_batch');
  });

  it('无引用晋升的正式对象 → 200 traceable=false / no_promotion（不是错误）', async () => {
    const { app } = setup();
    const res = await get(app, '/radar/applications/created-outside-radar/promotion-trace');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ traceable: false, reason: 'no_promotion', objectKind: 'application' });
  });
});
