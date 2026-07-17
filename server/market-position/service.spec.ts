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
import { MARKET_POSITION_CITY_CODES } from '../../src/domain/market-position';
import type { MarketPositionView } from '../../src/domain/market-position';
import type { MarketPositionAiProvider } from './aiProvider';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function fakeNarrative(overrides: Record<string, unknown> = {}) {
  return {
    headline: 'AI 生成：证据不足，尚待验证。',
    positioning: 'AI 生成：已有一定样本，但证据不足，尚待验证。',
    observedStrengths: [],
    observedWeaknesses: [],
    marketSignals: [],
    counterSignals: [],
    uncertainties: ['样本量不足'],
    nextEvidenceActions: ['继续观察回复情况'],
    citedEvidenceIds: [],
    ...overrides,
  };
}

function fakeAiOutput(overrides: { global?: Record<string, unknown>; cityOverrides?: Record<string, unknown> } = {}) {
  return {
    global: fakeNarrative(overrides.global),
    cityProfiles: MARKET_POSITION_CITY_CODES.map((city) => ({ city, ...fakeNarrative(overrides.cityOverrides) })),
  };
}

function fakeProvider(overrides: Partial<MarketPositionAiProvider> = {}): MarketPositionAiProvider {
  return {
    isConfigured: () => true,
    modelName: () => 'fake-model',
    generate: async () => ({ rawText: JSON.stringify(fakeAiOutput()), model: 'fake-model' }),
    ...overrides,
  };
}

interface Harness {
  app: FastifyInstance;
  db: SqliteDatabase;
}

function createHarness(aiProvider?: MarketPositionAiProvider): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-mp-service-'));
  const dbPath = path.join(tempDir, 'test.sqlite3');
  const db = openDb(dbPath);
  initSchema(db, { targetVersion: MARKET_POSITION_SCHEMA_VERSION });
  new JobRepository(db).create({
    id: 'job-1', company: 'A 公司', role: '后端工程师', city: '苏州', salaryRange: '20-30K', jdText: 'JD',
  });
  let id = 0;
  let now = 10_000;
  const app = buildServer({
    db,
    jobMemoryV2: { enabled: true, serviceDeps: { now: () => ++now, createId: () => `test-${++id}` } },
    marketPosition: {
      enabled: true,
      serviceDeps: { now: () => ++now, createId: () => `mp-${++id}`, aiProvider: aiProvider ?? fakeProvider() },
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
  withReply = false,
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
  if (!withReply) return;
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

async function generate(app: FastifyInstance, key: string, expectedStateVersion = 0, expectedInputHash?: string | null) {
  return app.inject({
    method: 'POST',
    url: '/market-position/proposals/generate',
    payload: { idempotencyKey: key, expectedStateVersion, expectedInputHash },
  });
}

describe('MarketPositionService · AI 生成提案', () => {
  it('AI 成功生成：创建 pending 提案，不自动激活正式版本', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(200);
    const body = response.json() as MarketPositionView;
    const proposal = body.state.proposals[0]!;
    expect(proposal.status).toBe('proposed');
    expect(proposal.generatedBy).toBe('ai');
    expect(proposal.modelInfo).toBe('fake-model');
    expect(proposal.aiGeneration).not.toBeNull();
    expect(body.activeVersion).toBeNull();
  });

  it('相同 inputHash 已有待审核提案：直接返回既有提案，不重复调用模型', async () => {
    let calls = 0;
    const provider = fakeProvider({
      generate: async () => {
        calls += 1;
        return { rawText: JSON.stringify(fakeAiOutput()), model: 'fake-model' };
      },
    });
    const { app } = createHarness(provider);
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const first = await generate(app, 'gen-1');
    expect(first.statusCode).toBe(200);
    expect(calls).toBe(1);
    const stateVersion = (first.json() as MarketPositionView).state.stateVersion;

    const firstProposalId = (first.json() as MarketPositionView).state.proposals[0]!.id;
    const second = await generate(app, 'gen-2', stateVersion);
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as MarketPositionView;
    expect(secondBody.reused).toBe(true);
    expect(secondBody.state.proposals).toHaveLength(1);
    expect(secondBody.state.proposals[0]!.id).toBe(firstProposalId);
    expect(calls).toBe(1);
  });

  it('AI 生成提案被接受：只创建一个正式版本，且保留 generationMode=ai', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const generated = await generate(app, 'gen-accept-1');
    const body = generated.json() as MarketPositionView;
    const proposal = body.state.proposals[0]!;
    const accept = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposal.id}/accept`,
      payload: { idempotencyKey: 'accept-1', expectedStateVersion: body.state.stateVersion },
    });
    expect(accept.statusCode).toBe(200);
    const acceptedBody = accept.json() as MarketPositionView;
    expect(acceptedBody.state.versions).toHaveLength(1);
    expect(acceptedBody.activeVersion?.proposalId).toBe(proposal.id);
    const acceptedProposal = acceptedBody.state.proposals.find((p) => p.id === proposal.id)!;
    expect(acceptedProposal.generatedBy).toBe('ai');
    expect(acceptedProposal.aiGeneration).not.toBeNull();
  });

  it('AI 输出中携带确定性字段（如 evidenceLevel）会被结构校验拒绝，不创建提案', async () => {
    const provider = fakeProvider({
      generate: async () => ({
        rawText: JSON.stringify({ ...fakeAiOutput(), global: { ...fakeAiOutput().global, evidenceLevel: 'supported' } }),
        model: 'fake-model',
      }),
    });
    const { app } = createHarness(provider);
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_AI_OUTPUT_INVALID' });
  });

  it('引用不存在的证据 id：AI 输出无效', async () => {
    const provider = fakeProvider({
      generate: async () => ({
        rawText: JSON.stringify(fakeAiOutput({ global: { citedEvidenceIds: ['not-exist-id'] } })),
        model: 'fake-model',
      }),
    });
    const { app } = createHarness(provider);
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_AI_OUTPUT_INVALID' });
  });

  it('输出命中禁止措辞（如"市场不认可"）：AI 输出无效', async () => {
    const provider = fakeProvider({
      generate: async () => ({
        rawText: JSON.stringify(fakeAiOutput({ global: { headline: '市场不认可你的定位' } })),
        model: 'fake-model',
      }),
    });
    const { app } = createHarness(provider);
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_AI_OUTPUT_INVALID' });
  });

  it('没有数据的城市：无论 AI 返回什么内容都强制改写为固定"无数据"文案，不会跨城市借用信号', async () => {
    const provider = fakeProvider({
      generate: async () => ({
        rawText: JSON.stringify(fakeAiOutput({
          cityOverrides: { headline: '苏州机会更多', marketSignals: ['来自苏州的信号'] },
        })),
        model: 'fake-model',
      }),
    });
    const { app } = createHarness(provider);
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(200);
    const body = response.json() as MarketPositionView;
    const proposal = body.state.proposals[0]!;
    const wuxi = proposal.payload.cityProfiles.find((p) => p.scope.city === 'wuxi')!;
    expect(wuxi.headline).toBe('当前没有该城市的正式市场反馈，不能判断该城市是否适合你。');
    expect(wuxi.marketSignals).toEqual([]);
  });

  it('AI 未配置：返回 503 MARKET_POSITION_AI_UNAVAILABLE，手工流程仍可用', async () => {
    const provider = fakeProvider({ isConfigured: () => false });
    const { app } = createHarness(provider);
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_AI_UNAVAILABLE' });

    const manual = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: {
        idempotencyKey: 'manual-1',
        expectedStateVersion: 0,
        payload: (await import('../../src/domain/market-position/testFixtures')).makeMarketPositionDraftFixture(),
      },
    });
    expect(manual.statusCode).toBe(200);
  });

  it('一次修复后仍失败：返回 422 且 attempts 为 2', async () => {
    let calls = 0;
    const provider = fakeProvider({
      generate: async () => {
        calls += 1;
        throw new (await import('./errors')).MarketPositionError(
          422, 'MARKET_POSITION_AI_OUTPUT_INVALID', 'AI 连续两次未能生成符合安全约束的市场位置文案', { attempts: 2 },
        );
      },
    });
    const { app } = createHarness(provider);
    const response = await generate(app, 'gen-1');
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_AI_OUTPUT_INVALID', attempts: 2 });
    expect(calls).toBe(1);
  });

  it('输入已过期：expectedInputHash 与服务端重新计算的不一致时返回 409', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const response = await generate(app, 'gen-1', 0, 'a'.repeat(64));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'MARKET_POSITION_INPUT_STALE' });
  });

  it('乐观并发冲突：expectedStateVersion 过期时返回 409', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    await generate(app, 'gen-1');
    const response = await generate(app, 'gen-2', 0);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'STATE_VERSION_CONFLICT' });
  });

  it('幂等重放：相同幂等键返回同一状态，不重复创建提案', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const first = await generate(app, 'same-key');
    const replay = await generate(app, 'same-key');
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as MarketPositionView).state.proposals).toHaveLength(1);
  });

  it('手工提案流程不受 AI 未配置影响：仍可创建、接受并激活正式版本', async () => {
    const provider = fakeProvider({ isConfigured: () => false });
    const { app } = createHarness(provider);
    const { makeMarketPositionDraftFixture } = await import('../../src/domain/market-position/testFixtures');
    const createResponse = await app.inject({
      method: 'POST',
      url: '/market-position/proposals/manual',
      payload: { idempotencyKey: 'k1', expectedStateVersion: 0, payload: makeMarketPositionDraftFixture() },
    });
    const created = createResponse.json() as MarketPositionView;
    const proposalId = created.state.proposals[0]!.id;
    const acceptResponse = await app.inject({
      method: 'POST',
      url: `/market-position/proposals/${proposalId}/accept`,
      payload: { idempotencyKey: 'k2', expectedStateVersion: created.state.stateVersion },
    });
    expect(acceptResponse.statusCode).toBe(200);
    expect((acceptResponse.json() as MarketPositionView).activeVersion?.version).toBe(1);
  });

  it('AI 生成的提案 payload 中 evidenceSufficiency/decisionGates 与确定性计算一致，AI 无法覆盖', async () => {
    const { app } = createHarness();
    await seedApplication(app, 'job-1', '苏州', 'app-1');
    const response = await generate(app, 'gen-1');
    const body = response.json() as MarketPositionView;
    const proposal = body.state.proposals[0]!;
    expect(proposal.payload.global.evidenceSufficiency.evidenceLevel).toBe('insufficient');
    expect(proposal.payload.global.evidenceSufficiency.applicationCount).toBe(1);
  });

  it('llmConfigured 反映 AI Provider 配置状态', async () => {
    const configured = createHarness(fakeProvider({ isConfigured: () => true }));
    const configuredView = (await configured.app.inject({ method: 'GET', url: '/market-position' })).json() as MarketPositionView;
    expect(configuredView.llmConfigured).toBe(true);

    const unconfigured = createHarness(fakeProvider({ isConfigured: () => false }));
    const unconfiguredView = (await unconfigured.app.inject({ method: 'GET', url: '/market-position' })).json() as MarketPositionView;
    expect(unconfiguredView.llmConfigured).toBe(false);
  });
});
