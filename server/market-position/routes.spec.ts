import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { buildServer } from '../index';
import { JobRepository } from '../repositories/jobRepository';
import { MARKET_POSITION_SCHEMA_VERSION } from '../migrations';
import { initSchema } from '../schema';
import { makeMarketPositionDraftFixture } from '../../src/domain/market-position/testFixtures';
import type { MarketPositionDraft, MarketPositionView } from '../../src/domain/market-position';

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-mp-api-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: MARKET_POSITION_SCHEMA_VERSION });
  new JobRepository(db).create({
    id: 'job-1',
    company: 'A 公司',
    role: '后端工程师',
    city: '苏州',
    salaryRange: '20-30K',
    jdText: 'JD',
  });
  new JobRepository(db).create({
    id: 'job-2',
    company: 'B 公司',
    role: '后端工程师',
    city: '无锡',
    salaryRange: '20-30K',
    jdText: 'JD',
  });
  let id = 0;
  let now = 10_000;
  const app = buildServer({
    db,
    jobMemoryV2: {
      enabled: true,
      serviceDeps: { now: () => ++now, createId: () => `test-${++id}` },
    },
    marketPosition: {
      enabled: true,
      serviceDeps: { now: () => ++now, createId: () => `mp-${++id}` },
    },
  });
  cleanups.push(async () => {
    await app.close();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, db };
}

async function seedApplication(
  app: FastifyInstance,
  jobId: string,
  city: string,
  idempotencyKey: string,
): Promise<void> {
  const createResponse = await app.inject({
    method: 'POST',
    url: `/jobs/${jobId}/applications`,
    payload: {
      idempotencyKey,
      resumeVersionId: null,
      origin: 'outbound',
      channel: 'boss',
      channelOtherLabel: null,
      recruitingEntity: { kind: 'direct_employer', name: '公司', employerGroupKey: null, endClientName: null },
      primaryContact: null,
      cityContext: { jobCity: city, marketCity: city, workMode: 'onsite' },
      draftMessageText: null,
      initialEvent: null,
    },
  });
  if (createResponse.statusCode !== 200) {
    throw new Error(`seedApplication failed: ${createResponse.statusCode} ${createResponse.body}`);
  }
  const applicationId = (createResponse.json() as { applications: Array<{ record: { id: string } }> })
    .applications[0]?.record.id as string;
  await app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/events`,
    payload: {
      eventType: 'hr_replied',
      eventAt: 20_000,
      timePrecision: 'exact',
      actor: 'user',
      sourceConfidence: 'exact',
      evidenceLevel: 'strong',
      channel: 'boss',
      note: null,
      reasonCode: null,
      payload: {},
    },
  });
}

function manualPayload(overrides: Partial<MarketPositionDraft> = {}): MarketPositionDraft {
  return { ...makeMarketPositionDraftFixture(), ...overrides };
}

describe('GET /market-position', () => {
  it('空状态：无正式版本，state 为初始状态', async () => {
    const { app } = createHarness();
    const response = await app.inject({ method: 'GET', url: '/market-position' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as MarketPositionView;
    expect(body.activeVersion).toBeNull();
    expect(body.state.stateVersion).toBe(0);
    expect(typeof body.llmConfigured).toBe('boolean');
  });
});

describe('GET /market-position/input-snapshot', () => {
  it('城市隔离：苏州证据不计入无锡计数', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-sz-1');
    await seedApplication(app, 'job-2', '无锡', 'app-wx-1');

    const response = await app.inject({ method: 'GET', url: '/market-position/input-snapshot' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      countsByScope: { global: { applicationCount: number }; cities: Record<string, { applicationCount: number; validReplyCount: number }> };
    };
    expect(body.countsByScope.global.applicationCount).toBe(2);
    expect(body.countsByScope.cities.suzhou?.applicationCount).toBe(1);
    expect(body.countsByScope.cities.wuxi?.applicationCount).toBe(1);
    expect(body.countsByScope.cities.shanghai?.applicationCount).toBe(0);
    expect(body.countsByScope.cities.hangzhou?.applicationCount).toBe(0);
  });
});

describe('POST /market-position/proposals/manual', () => {
  it('手工提案：进入 proposed 状态，不改变正式版本', async () => {
    const { app } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as MarketPositionView;
    expect(body.state.proposals).toHaveLength(1);
    expect(body.state.proposals[0]?.status).toBe('proposed');
    expect(body.activeVersion).toBeNull();
  });

  it('乐观并发冲突：expectedStateVersion 过期返回 409', async () => {
    const { app } = createHarness();
    await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k2', expectedStateVersion: 0, payload: manualPayload({ dataCutoffAt: 999 }) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'STATE_VERSION_CONFLICT' });
  });

  it('幂等重放：相同幂等键返回同一状态，不重复创建提案', async () => {
    const { app } = createHarness();
    const payload = { idempotencyKey: 'same-key', expectedStateVersion: 0, payload: manualPayload() };
    const first = await app.inject({ method: 'POST', url: '/market-position/proposals/manual', payload });
    const replay = await app.inject({ method: 'POST', url: '/market-position/proposals/manual', payload });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as MarketPositionView).state.proposals).toHaveLength(1);
  });

  it('幂等键复用于不同请求：返回 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { app } = createHarness();
    await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'dup-key', expectedStateVersion: 0, payload: manualPayload() },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'dup-key', expectedStateVersion: 0, payload: manualPayload({ dataCutoffAt: 555 }) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('市场位置提案 · 审核与版本流转', () => {
  it('接受提案：创建 V1 正式版本并激活', async () => {
    const { app } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    const created = createResponse.json() as MarketPositionView;
    const proposalId = created.state.proposals[0]!.id;

    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/accept`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: created.state.stateVersion, decisionNote: '确认' },
    });
    expect(acceptResponse.statusCode).toBe(200);
    const accepted = acceptResponse.json() as MarketPositionView;
    expect(accepted.activeVersion?.version).toBe(1);
    expect(accepted.state.proposals[0]?.status).toBe('accepted');
  });

  it('修改后接受：保存差异并生成新版本', async () => {
    const { app } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    const created = createResponse.json() as MarketPositionView;
    const proposalId = created.state.proposals[0]!.id;
    const modifiedPayload = manualPayload();
    modifiedPayload.global.headline = '修改后的概述';

    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/accept`,
      payload: {
        idempotencyKey: 'k2', expectedStateVersion: created.state.stateVersion,
        decisionNote: '修改后确认', modifiedPayload,
      },
    });
    expect(acceptResponse.statusCode).toBe(200);
    const accepted = acceptResponse.json() as MarketPositionView;
    expect(accepted.activeVersion?.global.headline).toBe('修改后的概述');
    expect(accepted.state.proposals[0]?.status).toBe('modified_and_accepted');
    expect(accepted.state.proposals[0]?.decisionDiff.length).toBeGreaterThan(0);
  });

  it('拒绝 / 稍后处理提案不改变正式版本', async () => {
    const { app } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    const created = createResponse.json() as MarketPositionView;
    const proposalId = created.state.proposals[0]!.id;

    const rejectResponse = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/reject`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: created.state.stateVersion, decisionNote: '拒绝' },
    });
    expect(rejectResponse.statusCode).toBe(200);
    const rejected = rejectResponse.json() as MarketPositionView;
    expect(rejected.activeVersion).toBeNull();
    expect(rejected.state.proposals[0]?.status).toBe('rejected');
  });

  it('已处理提案不能被重复审核：返回 409 PROPOSAL_ALREADY_DECIDED', async () => {
    const { app } = createHarness();
    const createResponse = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    const created = createResponse.json() as MarketPositionView;
    const proposalId = created.state.proposals[0]!.id;

    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/accept`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: created.state.stateVersion },
    });
    const accepted = acceptResponse.json() as MarketPositionView;
    const secondAccept = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/accept`,
      payload: { idempotencyKey: 'k3', expectedStateVersion: accepted.state.stateVersion },
    });
    expect(secondAccept.statusCode).toBe(409);
    expect(secondAccept.json()).toMatchObject({ code: 'PROPOSAL_ALREADY_DECIDED' });
  });

  it('历史版本可重新激活；旧版本内容不可原地修改', async () => {
    const { app } = createHarness();
    const first = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    let view = first.json() as MarketPositionView;
    const acceptFirst = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${view.state.proposals[0]!.id}/accept`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: view.state.stateVersion },
    });
    view = acceptFirst.json() as MarketPositionView;
    const v1Id = view.activeVersion!.id;
    const v1HeadlineBefore = view.activeVersion!.global.headline;

    const second = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: {
        idempotencyKey: 'k3', expectedStateVersion: view.state.stateVersion,
        payload: manualPayload({ dataCutoffAt: view.activeVersion!.dataCutoffAt + 1 }),
      },
    });
    view = second.json() as MarketPositionView;
    const secondProposal = view.state.proposals.find((p) => p.status === 'proposed')!;
    const acceptSecond = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${secondProposal.id}/accept`,
      payload: { idempotencyKey: 'k4', expectedStateVersion: view.state.stateVersion },
    });
    view = acceptSecond.json() as MarketPositionView;
    expect(view.activeVersion?.version).toBe(2);

    const activate = await app.inject({
      method: 'POST',
      url: `/market-position/versions/${v1Id}/activate`,
      payload: { idempotencyKey: 'k5', expectedStateVersion: view.state.stateVersion, confirmed: true },
    });
    expect(activate.statusCode).toBe(200);
    const activated = activate.json() as MarketPositionView;
    expect(activated.activeVersion?.id).toBe(v1Id);
    expect(activated.activeVersion?.global.headline).toBe(v1HeadlineBefore);
  });

  it('提案与当前正式版本没有有效变化时返回 422 NO_EFFECTIVE_CHANGE', async () => {
    const { app } = createHarness();
    const first = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: manualPayload() },
    });
    let view = first.json() as MarketPositionView;
    const acceptFirst = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${view.state.proposals[0]!.id}/accept`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: view.state.stateVersion },
    });
    view = acceptFirst.json() as MarketPositionView;

    const {
      id: _id, version: _version, status: _status, inputSnapshot: _inputSnapshot,
      createdAt: _createdAt, activatedAt: _activatedAt,
      supersedesVersionId: _supersedesVersionId, proposalId: _proposalId,
      ...duplicateDraft
    } = view.activeVersion!;
    const response = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k3', expectedStateVersion: view.state.stateVersion, payload: duplicateDraft },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'NO_EFFECTIVE_CHANGE' });
  });
});
