import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { getDatabaseSchemaVersion } from '../migrations';
import { JobRepository } from '../repositories/jobRepository';
import { initSchema } from '../schema';

interface ApiHarness {
  tempDir: string;
  db: SqliteDatabase;
  app: FastifyInstance;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function makeTempPath(prefix: string): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { tempDir, dbPath: path.join(tempDir, 'test.sqlite3') };
}

function createV2Api(): ApiHarness {
  const { tempDir, dbPath } = makeTempPath('offerflow-job-memory-api-');
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: 2 });
  new JobRepository(db).create({
    id: 'job-1',
    company: 'API 公司',
    role: '前端工程师',
    city: '苏州',
    salaryRange: '20-30K',
    jdText: 'Vue TypeScript',
  });
  let id = 0;
  let now = 10_000;
  const app = buildServer({
    db,
    jobMemoryV2: {
      enabled: true,
      serviceDeps: {
        now: () => ++now,
        createId: () => `api-${++id}`,
      },
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { tempDir, db, app };
}

function resumePayload(key = 'resume-key') {
  return {
    idempotencyKey: key,
    name: 'API 简历',
    source: 'pasted_text',
    summary: '前端',
    contentSnapshot: { resumeText: 'Vue', projectExperience: 'OfferFlow' },
  };
}

function applicationPayload(resumeVersionId: string | null = null) {
  return {
    idempotencyKey: 'application-key',
    resumeVersionId,
    origin: 'outbound',
    channel: 'boss',
    channelOtherLabel: null,
    recruitingEntity: {
      kind: 'direct_employer',
      name: 'API 公司',
      employerGroupKey: null,
      endClientName: null,
    },
    primaryContact: null,
    cityContext: { jobCity: '苏州', marketCity: '苏州', workMode: 'onsite' },
    draftMessageText: null,
    initialEvent: null,
  };
}

function feedbackEvent(eventType: string) {
  return {
    eventType,
    eventAt: 20_000,
    timePrecision: 'exact',
    actor: 'user',
    sourceConfidence: 'exact',
    evidenceLevel: 'strong',
    channel: 'boss',
    note: null,
    reasonCode: null,
    payload: {},
  };
}

describe('Job Memory capability gate', () => {
  it('默认 Server 保持 schema v1 且不注册 v2 routes', async () => {
    const { tempDir, dbPath } = makeTempPath('offerflow-job-memory-disabled-');
    const app = buildServer(dbPath);
    cleanups.push(async () => {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const response = await app.inject({ method: 'GET', url: '/resume-versions' });
    expect(response.statusCode).toBe(404);
    expect(app.db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").pluck().get())
      .toBe('1');
  });

  it('capability=true 遇到 v1 DB 时在 Server 创建阶段明确失败', () => {
    const { tempDir, dbPath } = makeTempPath('offerflow-job-memory-v1-rejected-');
    const db = openDb(dbPath);
    initSchema(db);
    db.close();
    cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    expect(() => buildServer({ dbPath, jobMemoryV2: { enabled: true } }))
      .toThrow(/requires schema version 2.*current version is 1/);
  });

  it('capability=true 只接受显式初始化到 v2 的数据库', async () => {
    const { app, db } = createV2Api();
    expect(getDatabaseSchemaVersion(db)).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/resume-versions' })).statusCode).toBe(200);
  });
});

describe('Job Memory HTTP API', () => {
  it('统一返回非法 JSON、DTO、404 和 409 错误结构', async () => {
    const { app } = createV2Api();
    const invalidJson = await app.inject({
      method: 'POST',
      url: '/resume-versions',
      headers: { 'content-type': 'application/json' },
      payload: '{broken',
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json()).toEqual({ code: 'INVALID_JSON', message: '请求体不是合法 JSON' });

    const unknownField = await app.inject({
      method: 'POST',
      url: '/resume-versions',
      payload: { ...resumePayload(), createdAt: 1 },
    });
    expect(unknownField.statusCode).toBe(422);
    expect(unknownField.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(unknownField.json().fieldErrors).toBeTypeOf('object');

    const missing = await app.inject({ method: 'GET', url: '/jobs/missing/bundle' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'JOB_NOT_FOUND', message: '岗位不存在' });

    expect((await app.inject({
      method: 'POST',
      url: '/resume-versions',
      payload: resumePayload(),
    })).statusCode).toBe(200);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/resume-versions',
      payload: resumePayload('another-key'),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'CONTENT_HASH_EXISTS', existingId: 'api-1' });
  });

  it('覆盖 ResumeVersion、Application、Event、Bundle 与 summaries endpoints', async () => {
    const { app } = createV2Api();
    const resumeResponse = await app.inject({
      method: 'POST',
      url: '/resume-versions',
      payload: resumePayload(),
    });
    const resume = resumeResponse.json();
    const resumeId = String(resume.id);
    expect((await app.inject({
      method: 'PATCH',
      url: `/resume-versions/${resumeId}`,
      payload: { expectedVersion: 1, summary: '更新摘要' },
    })).json()).toMatchObject({ rowVersion: 2, summary: '更新摘要' });
    expect((await app.inject({
      method: 'POST',
      url: `/resume-versions/${resumeId}/activate`,
      payload: { expectedVersion: 2 },
    })).json()).toMatchObject({ activeResumeVersionId: resumeId });

    const applicationResponse = await app.inject({
      method: 'POST',
      url: '/jobs/job-1/applications',
      payload: applicationPayload(resumeId),
    });
    expect(applicationResponse.statusCode).toBe(200);
    const applicationBundle = applicationResponse.json();
    const applicationId = String(applicationBundle.applications[0].record.id);
    expect(applicationBundle.applications[0].events[0].eventType).toBe('application_created');

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/applications/${applicationId}`,
      payload: {
        expectedVersion: 1,
        reason: '修正联系人',
        primaryContact: { displayName: '小王', role: 'company_hr', platformId: null },
      },
    });
    expect(patchResponse.json().applications[0].record.rowVersion).toBe(2);

    const appendResponse = await app.inject({
      method: 'POST',
      url: `/applications/${applicationId}/events`,
      payload: {
        idempotencyKey: 'http-event',
        expectedApplicationVersion: 2,
        ...feedbackEvent('greeting_sent'),
      },
    });
    const appended = appendResponse.json();
    expect(appended.applications[0].record.rowVersion).toBe(3);
    const eventId = String(
      appended.applications[0].events.find((event: { eventType: string }) => (
        event.eventType === 'greeting_sent'
      )).id,
    );

    const voidEventResponse = await app.inject({
      method: 'POST',
      url: `/feedback-events/${eventId}/void`,
      payload: {
        idempotencyKey: 'http-void-event',
        expectedApplicationVersion: 3,
        reason: '误录',
        replacementEvent: feedbackEvent('hr_replied'),
      },
    });
    expect(voidEventResponse.json().applications[0]).toMatchObject({
      record: { rowVersion: 4 },
      projection: { communicationStatus: 'replied' },
    });

    expect((await app.inject({ method: 'GET', url: '/jobs/summaries' })).json()[0])
      .toMatchObject({
        applicationCount: 1,
        activeApplicationCount: 1,
        defaultResumeVersionName: 'API 简历',
        defaultApplication: { record: { id: applicationId } },
      });
    expect((await app.inject({ method: 'GET', url: '/jobs/job-1/bundle' })).json())
      .toMatchObject({ jobId: 'job-1', memory: { activeResumeVersionId: resumeId } });

    const voidApplicationResponse = await app.inject({
      method: 'POST',
      url: `/applications/${applicationId}/void`,
      payload: { expectedVersion: 4, reason: '流程误录' },
    });
    expect(voidApplicationResponse.json().applications[0].record)
      .toMatchObject({ rowVersion: 5, voidReason: '流程误录' });

    expect((await app.inject({
      method: 'POST',
      url: `/resume-versions/${resumeId}/archive`,
      payload: { expectedVersion: 2, clearActive: true },
    })).json()).toMatchObject({ activeResumeVersionId: null });
    expect((await app.inject({ method: 'GET', url: '/resume-versions' })).json())
      .toMatchObject({ activeResumeVersionId: null, resumeVersions: [{ rowVersion: 3 }] });
  });

  it('不向客户端泄漏 SQLite 或存储损坏细节', async () => {
    const { app, db } = createV2Api();
    await app.inject({ method: 'POST', url: '/resume-versions', payload: resumePayload() });
    db.prepare("UPDATE resume_versions SET content_json = '{broken'").run();
    const response = await app.inject({ method: 'GET', url: '/resume-versions' });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    expect(response.body).not.toContain('SQLite');
    expect(response.body).not.toContain('content_json');
  });
});
