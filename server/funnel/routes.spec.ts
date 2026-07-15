import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { JobRepository } from '../repositories/jobRepository';
import { initSchema } from '../schema';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

function createHarness(): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-funnel-api-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: 2 });
  new JobRepository(db).create({
    id: 'job-1',
    company: 'A 公司',
    role: '后端工程师',
    city: '上海',
    salaryRange: '20-30K',
    jdText: 'JD',
  });
  let id = 0;
  let now = 10_000;
  const app = buildServer({
    db,
    jobMemoryV2: {
      enabled: true,
      serviceDeps: {
        now: () => ++now,
        createId: () => `test-${++id}`,
      },
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

function applicationPayload(idempotencyKey: string) {
  return {
    idempotencyKey,
    resumeVersionId: null,
    origin: 'outbound',
    channel: 'boss',
    channelOtherLabel: null,
    recruitingEntity: { kind: 'direct_employer', name: 'A 公司', employerGroupKey: null, endClientName: null },
    primaryContact: null,
    cityContext: { jobCity: '上海', marketCity: '上海', workMode: 'onsite' },
    draftMessageText: null,
    initialEvent: null,
  };
}

function eventPayload(eventType: string) {
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

describe('GET /funnel', () => {
  it('从正式 Application/FeedbackEvent 聚合基础漏斗', async () => {
    const { app } = createHarness();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs/job-1/applications',
      payload: applicationPayload('app-key-1'),
    });
    expect(createResponse.statusCode).toBe(200);
    const applicationId = (createResponse.json() as { applications: Array<{ record: { id: string } }> })
      .applications[0]?.record.id as string;

    await app.inject({
      method: 'POST',
      url: `/applications/${applicationId}/events`,
      payload: eventPayload('hr_replied'),
    });

    const response = await app.inject({ method: 'GET', url: '/funnel' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      totalProcessCount: number;
      groups: Array<{ key: { city: string | null; roleFamily: string; channel: string } }>;
      exclusions: { notes: string[] };
    };
    expect(body.totalProcessCount).toBe(1);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.key).toEqual({
      city: '上海',
      roleFamily: '后端工程师',
      channel: 'boss',
      resumeVersionId: null,
      windowLabel: null,
    });
    expect(body.exclusions.notes.length).toBeGreaterThan(0);
  });

  it('查询参数非法时返回 422', async () => {
    const { app } = createHarness();
    const response = await app.inject({ method: 'GET', url: '/funnel?from=100&to=50' });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('按渠道过滤后其它渠道流程不计入分母', async () => {
    const { app } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/jobs/job-1/applications',
      payload: applicationPayload('app-key-2'),
    });
    expect(createResponse.statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/funnel?channel=referral' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { totalProcessCount: number }).totalProcessCount).toBe(0);
  });
});
