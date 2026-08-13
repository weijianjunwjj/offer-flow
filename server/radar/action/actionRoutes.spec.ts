/**
 * RC-10 第二波 · 雷达动作 HTTP 路由测试。
 *
 * 覆盖：apply/revert/getView 契约；共用采集安全网关（缺自定义头 403）；
 * schema < v8 不注册动作路由（404）；appliedPending 由服务端解析快照锚点；
 * 严格 DTO 拒绝客户端伪造 appliedAt / candidateVersionId（422）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../../db';
import { buildServer } from '../../index';
import { initSchema } from '../../schema';
import { RadarCaptureService } from '../service';

const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';
const cleanups: Array<() => void> = [];
let app: FastifyInstance;
let db: SqliteDatabase;
let candidateId: string;

function headers(extra: Record<string, string> = {}) {
  return { [CAPTURE_CLIENT_HEADER]: 'test-extension', ...extra };
}
function seedCandidate(database: SqliteDatabase): string {
  let s = 0;
  const capture = new RadarCaptureService(database, { now: () => 1_700_000_000 + s, createId: () => `cap-${(s += 1)}` });
  const session = capture.createSession({ sourceType: 'browser' });
  capture.addItem(session.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: 'https://www.zhipin.com/job_detail/act-route.html', sourceDomain: 'zhipin.com',
    pageTitle: null, visibleText: '岗位：后端 @ 公司X 苏州', externalRecordId: 'act-route',
    recognizedFields: {
      company: '公司X', role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  return capture.commitSession(session.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!.candidateId!;
}

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-action-routes-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 9 });
  candidateId = seedCandidate(db);
  let counter = 0;
  let now = 2_000_000;
  app = buildServer({ db, radar: { enabled: true, serviceDeps: { now: () => (now += 1000), createId: () => `av-${(counter += 1)}` } } });
  cleanups.push(() => { void app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
});
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function post(url: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: headers(extra), payload: body });
}

describe('动作路由：apply / revert / getView', () => {
  it('apply→getView→revert 全链路：状态与历史正确', async () => {
    const applied = await post('/radar/actions/apply', { candidateId, family: 'save', reason: '高匹配' });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ changed: true, view: { state: { saved: true } } });

    const view = await app.inject({ method: 'GET', url: `/radar/actions/candidates/${candidateId}`, headers: headers() });
    expect(view.statusCode).toBe(200);
    const body = view.json() as { state: { saved: boolean }; history: Array<{ actionType: string; reason: string | null }> };
    expect(body.state.saved).toBe(true);
    expect(body.history.at(-1)).toMatchObject({ actionType: 'saved', reason: '高匹配' });

    const reverted = await post('/radar/actions/revert', { candidateId, family: 'save' });
    expect(reverted.json()).toMatchObject({ changed: true, view: { state: { saved: false } } });
  });

  it('appliedPending 由服务端解析 sourceSnapshotId（客户端只给 channel）', async () => {
    const res = await post('/radar/actions/apply', { candidateId, family: 'appliedPending', channel: 'boss' });
    expect(res.statusCode).toBe(200);
    const row = db.prepare(
      `SELECT metadata_json m FROM radar_actions WHERE candidate_id = ? AND action_type = 'marked_applied_pending'`,
    ).get(candidateId) as { m: string };
    const meta = JSON.parse(row.m) as Record<string, unknown>;
    // sourceSnapshotId 来自服务端 review 详情（非客户端提供），channel 为用户输入。
    expect(meta.sourceSnapshotId).not.toBeNull();
    expect(meta.channel).toBe('boss');
    expect(typeof meta.appliedAt).toBe('number');
  });

  it('拒绝客户端伪造锚点字段（严格 DTO → 422）', async () => {
    const res = await post('/radar/actions/apply', { candidateId, family: 'save', appliedAt: 1, candidateVersionId: 'x' });
    expect(res.statusCode).toBe(422);
  });

  it('拒绝未知 family（严格 enum → 422）', async () => {
    const res = await post('/radar/actions/apply', { candidateId, family: 'promote' });
    expect(res.statusCode).toBe(422);
  });
});

describe('动作路由：安全网关与 schema 门禁', () => {
  it('缺采集自定义头 → 403（与采集桥同网关）', async () => {
    const res = await app.inject({ method: 'POST', url: '/radar/actions/apply', payload: { candidateId, family: 'save' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('schema < v8（v7 库）不注册动作路由 → 404', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-action-v7-'));
    const v7 = openDb(path.join(tempDir, 'v7.sqlite3'));
    initSchema(v7, { targetVersion: 7 });
    const v7app = buildServer({ db: v7, radar: { enabled: true } });
    cleanups.push(() => { void v7app.close(); v7.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
    const res = await v7app.inject({
      method: 'POST', url: '/radar/actions/apply', headers: headers(), payload: { candidateId: 'x', family: 'save' },
    });
    expect(res.statusCode).toBe(404);
  });
});
