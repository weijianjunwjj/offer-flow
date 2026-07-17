import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { JobRepository } from '../repositories/jobRepository';
import {
  LEGACY_COMMUNICATION_WRITE_DISABLED,
  LegacyCommunicationWriteError,
} from '../repositories/legacyCommunicationGuard';
import { initSchema } from '../schema';

interface Harness {
  tempDir: string;
  db: SqliteDatabase;
  app: FastifyInstance;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function harness(v2: boolean): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `offerflow-job-write-${v2 ? 'v2' : 'v1'}-`));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: v2 ? 2 : 1 });
  const app = buildServer({ db, jobMemoryV2: { enabled: v2 } });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { tempDir, db, app };
}

async function createDefaultJob(app: FastifyInstance, id = 'job-1') {
  const response = await app.inject({
    method: 'POST', url: '/jobs',
    payload: { id, company: '甲公司', role: '前端', city: '苏州', jdText: 'Vue' },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function expectDisabled(response: { statusCode: number; json(): unknown }, field: string): void {
  expect(response.statusCode).toBe(422);
  expect(response.json()).toMatchObject({
    code: LEGACY_COMMUNICATION_WRITE_DISABLED,
    fieldErrors: { [field]: ['该字段在 v2 模式下只读'] },
  });
}

function applicationPayload() {
  return {
    idempotencyKey: 'application-key', resumeVersionId: null, origin: 'outbound', channel: 'boss',
    channelOtherLabel: null,
    recruitingEntity: { kind: 'direct_employer', name: '甲公司', employerGroupKey: null, endClientName: null },
    primaryContact: null, cityContext: { jobCity: '苏州', marketCity: '苏州', workMode: 'onsite' },
    draftMessageText: 'Application 草稿', initialEvent: null,
  };
}

describe('v2 legacy Job 写入门禁', () => {
  it.each([
    ['communicationStatus', 'not_contacted'],
    ['followupCount', 1],
    ['lastGreetedAt', 100],
    ['lastFollowupAt', 200],
    ['lastCommunicationNote', '已联系'],
  ])('PATCH %s 即使单字段也返回稳定 422', async (field, value) => {
    const { app } = harness(true);
    await createDefaultJob(app);
    const response = await app.inject({ method: 'PATCH', url: '/jobs/job-1', payload: { [field]: value } });
    expectDisabled(response, field);
  });

  it('PATCH 含禁用字段时整体回滚，不部分改 data_json', async () => {
    const { app, db } = harness(true);
    await createDefaultJob(app);
    const before = db.prepare('SELECT data_json FROM jobs WHERE id = ?').pluck().get('job-1');
    const response = await app.inject({
      method: 'PATCH', url: '/jobs/job-1', payload: { company: '不应写入', communicationStatus: 'replied' },
    });
    expectDisabled(response, 'communicationStatus');
    expect(db.prepare('SELECT data_json FROM jobs WHERE id = ?').pluck().get('job-1')).toBe(before);
  });

  it('PUT legacy 未变化允许其他字段更新，发生变化则拒绝', async () => {
    const { app } = harness(true);
    const created = await createDefaultJob(app);
    const allowed = await app.inject({
      method: 'PUT', url: '/jobs/job-1', payload: { ...created, company: '乙公司' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ company: '乙公司', communicationStatus: 'not_contacted' });
    const allowedBody = allowed.json() as Record<string, unknown>;
    const rejected = await app.inject({
      method: 'PUT', url: '/jobs/job-1',
      payload: { ...allowedBody, role: '高级前端', communicationStatus: 'interviewing' },
    });
    expectDisabled(rejected, 'communicationStatus');
    expect((await app.inject({ method: 'GET', url: '/jobs/job-1' })).json()).toMatchObject({
      company: '乙公司', role: '前端', communicationStatus: 'not_contacted',
    });
  });

  it('create 允许缺省/默认 legacy，拒绝伪造流程事实', async () => {
    const { app } = harness(true);
    await createDefaultJob(app, 'default-job');
    const explicitDefault = await app.inject({
      method: 'POST', url: '/jobs',
      payload: { id: 'explicit-default', communicationStatus: 'not_contacted', followupCount: 0 },
    });
    expect(explicitDefault.statusCode).toBe(200);
    const rejected = await app.inject({
      method: 'POST', url: '/jobs',
      payload: { id: 'fake-applied', communicationStatus: 'greeted_unread' },
    });
    expectDisabled(rejected, 'communicationStatus');
    expect((await app.inject({ method: 'GET', url: '/jobs' })).json()).toHaveLength(2);
  });

  it('analysis/review 白名单 PATCH 继续工作且不改变 legacy', async () => {
    const { app } = harness(true);
    await createDefaultJob(app);
    const response = await app.inject({
      method: 'PATCH', url: '/jobs/job-1',
      payload: { aiRawResult: 'AI 原文', parseStatus: 'unparsed', reviewStatus: 'confirmed' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      aiRawResult: 'AI 原文', parseStatus: 'unparsed', reviewStatus: 'confirmed',
      communicationStatus: 'not_contacted', followupCount: 0,
    });
  });

  it('零 Application 允许岗位级 draft；有 Application 后 Job draft 禁写但 Application draft 可写', async () => {
    const { app } = harness(true);
    await createDefaultJob(app);
    const jobDraft = await app.inject({
      method: 'PATCH', url: '/jobs/job-1', payload: { draftMessageText: '岗位级准备文本' },
    });
    expect(jobDraft.statusCode).toBe(200);
    const createdApplication = await app.inject({
      method: 'POST', url: '/jobs/job-1/applications', payload: applicationPayload(),
    });
    expect(createdApplication.statusCode).toBe(200);
    const application = createdApplication.json().applications[0].record;
    const jobWithLegacyDraft = (await app.inject({ method: 'GET', url: '/jobs/job-1' })).json() as Record<string, unknown>;
    const unchangedDraftPut = await app.inject({
      method: 'PUT', url: '/jobs/job-1',
      payload: { ...jobWithLegacyDraft, company: '允许修改公司', draftMessageText: '岗位级准备文本' },
    });
    expect(unchangedDraftPut.statusCode).toBe(200);
    const blocked = await app.inject({
      method: 'PATCH', url: '/jobs/job-1', payload: { draftMessageText: '旁路修改' },
    });
    expectDisabled(blocked, 'draftMessageText');
    const applicationDraft = await app.inject({
      method: 'PATCH', url: `/applications/${application.id}`,
      payload: { expectedVersion: application.rowVersion, reason: '更新正式流程草稿', draftMessageText: '流程草稿' },
    });
    expect(applicationDraft.statusCode).toBe(200);
    expect(applicationDraft.json().applications[0].record.draftMessageText).toBe('流程草稿');
  });

  it('localStorage import/upsert 不能绕过门禁且事务无部分写入', async () => {
    const { app } = harness(true);
    const template = await createDefaultJob(app, 'template');
    await app.inject({ method: 'DELETE', url: '/jobs/template' });
    const response = await app.inject({
      method: 'POST', url: '/imports/localstorage/apply',
      payload: {
        'offerflow:job:safe': JSON.stringify({ ...template, id: 'safe', company: '安全记录' }),
        'offerflow:job:unsafe': JSON.stringify({
          ...template, id: 'unsafe', company: '旁路记录', communicationStatus: 'rejected',
        }),
      },
    });
    expectDisabled(response, 'communicationStatus');
    expect((await app.inject({ method: 'GET', url: '/jobs' })).json()).toHaveLength(0);
  });

  it('显式 guarded repository 的 patch/replace 同样不可绕过', () => {
    const { db } = harness(true);
    new JobRepository(db).create({ id: 'job-1', company: '甲公司' });
    const guarded = new JobRepository(db, { legacyCommunicationWriteDisabled: true });
    expect(() => guarded.patch('job-1', { communicationStatus: 'replied' }))
      .toThrow(LegacyCommunicationWriteError);
    const current = guarded.get('job-1')!;
    expect(() => guarded.replace('job-1', { ...current, followupCount: 1 }))
      .toThrow(LegacyCommunicationWriteError);
  });
});

describe('v1 compatibility', () => {
  it('capability=false 保持 PATCH/PUT/create legacy 行为', async () => {
    const { app } = harness(false);
    await createDefaultJob(app);
    const patched = await app.inject({
      method: 'PATCH', url: '/jobs/job-1',
      payload: { communicationStatus: 'replied', followupCount: 1, lastCommunicationNote: '旧路径' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ communicationStatus: 'replied', followupCount: 1 });
    const put = await app.inject({ method: 'PUT', url: '/jobs/job-1', payload: { communicationStatus: 'rejected' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().communicationStatus).toBe('rejected');
    const created = await app.inject({
      method: 'POST', url: '/jobs', payload: { id: 'legacy-created', communicationStatus: 'interviewing' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().communicationStatus).toBe('interviewing');
  });
});
