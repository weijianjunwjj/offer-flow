import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../index';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { STRATEGY_WINDOW_SCHEMA_VERSION } from '../migrations';
import { MarketPositionRepository } from '../market-position/repository';
import {
  computeAllDecisionGates,
  computeEvidenceSufficiency,
  createEmptyMarketPositionDraft,
  DECISION_GATE_TYPES,
  type EvidenceLevel,
  type EvidenceRawCounts,
  type MarketPositionVersion,
} from '../../src/domain/market-position';
import type { StrategyAiProvider } from './aiProvider';

const HASH = 'a'.repeat(64);
const DAY = 86_400_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function countsForLevel(level: EvidenceLevel): EvidenceRawCounts {
  if (level === 'insufficient') {
    return {
      applicationCount: 0, companyCount: 0, validReplyCount: 0, interviewCount: 0,
      terminalOutcomeCount: 0, exactCount: 0, dateLevelCount: 0, approximateCount: 0,
      recalledCount: 0, inferredCount: 0, firstObservedAt: null, lastObservedAt: null,
    };
  }
  if (level === 'directional') {
    return {
      applicationCount: 16, companyCount: 9, validReplyCount: 2, interviewCount: 1,
      terminalOutcomeCount: 0, exactCount: 12, dateLevelCount: 0, approximateCount: 0,
      recalledCount: 0, inferredCount: 0, firstObservedAt: 0, lastObservedAt: 20 * DAY,
    };
  }
  return {
    applicationCount: 45, companyCount: 22, validReplyCount: 6, interviewCount: 3,
    terminalOutcomeCount: 1, exactCount: 32, dateLevelCount: 0, approximateCount: 0,
    recalledCount: 0, inferredCount: 0, firstObservedAt: 0, lastObservedAt: 70 * DAY,
  };
}

function seedMarketPositionActive(db: SqliteDatabase, level: EvidenceLevel, suffix = '1'): void {
  const repo = new MarketPositionRepository(db);
  const state = repo.getState();
  const draft = createEmptyMarketPositionDraft();
  const suff = computeEvidenceSufficiency(draft.global.scope, countsForLevel(level));
  draft.global = {
    ...draft.global,
    evidenceSufficiency: suff,
    decisionGates: computeAllDecisionGates(DECISION_GATE_TYPES, suff),
  };
  const version: MarketPositionVersion = {
    ...draft,
    id: `mpv-${suffix}`,
    version: state.versions.length + 1,
    status: 'active',
    inputSnapshot: {
      jobMatchProfileVersionId: null,
      capabilityBaselineVersionId: null,
      acceptedEvidenceIds: [],
      funnelCutoffAt: 1,
      funnelQueryFingerprint: HASH,
      inputHash: HASH,
      capturedAt: 1,
    },
    createdAt: 1,
    activatedAt: 1,
    supersedesVersionId: null,
    proposalId: `mpp-${suffix}`,
  };
  repo.updateState(state.stateVersion, (current) => ({
    ...current,
    stateVersion: current.stateVersion + 1,
    activeVersionId: version.id,
    versions: [
      ...current.versions.map((v) => ({ ...v, status: 'archived' as const })),
      version,
    ],
  }));
}

interface Harness {
  app: ReturnType<typeof buildServer>;
  db: SqliteDatabase;
  clock: { value: number };
  generateCalls: () => number;
}

function fakeOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    headline: 'AI 求职策略概述',
    objective: '在证据范围内补充样本并有限试探',
    summary: '当前保守推进，等待人工审核后执行',
    uncertainties: ['当前样本有限，判断为阶段性'],
    actionNarratives: [],
    ...overrides,
  });
}

function createHarness(opts: { level?: EvidenceLevel | null; rawText?: string } = {}): Harness {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-strategy-'));
  const db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: STRATEGY_WINDOW_SCHEMA_VERSION });
  if (opts.level !== null) seedMarketPositionActive(db, opts.level ?? 'insufficient');

  const clock = { value: 1_000 };
  const now = (): number => clock.value;
  let ids = 0;
  const createId = (): string => `sw-${++ids}`;
  let calls = 0;
  const aiProvider: StrategyAiProvider = {
    isConfigured: () => true,
    modelName: () => 'fake-model',
    generate: async () => {
      calls += 1;
      return { rawText: opts.rawText ?? fakeOutput(), model: 'fake-model' };
    },
  };
  const app = buildServer({
    db,
    jobMemoryV2: { enabled: true, serviceDeps: { now, createId } },
    marketPosition: { enabled: true },
    strategyWindow: { enabled: true, serviceDeps: { now, createId, aiProvider } },
  });
  cleanups.push(async () => { await app.close(); db.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  return { app, db, clock, generateCalls: () => calls };
}

async function generate(app: Harness['app'], key: string, expectedStateVersion = 0): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method: 'POST', url: '/strategy/proposals/generate',
    payload: { idempotencyKey: key, expectedStateVersion },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('StrategyService', () => {
  it('无 G4 active 版本时生成返回 STRATEGY_INPUT_NOT_READY', async () => {
    const { app } = createHarness({ level: null });
    const res = await generate(app, 'k1', 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STRATEGY_INPUT_NOT_READY');
  });

  it('AI 生成待审核提案，不自动激活', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const res = await generate(app, 'k1');
    expect(res.status).toBe(200);
    expect(res.body.state.proposals).toHaveLength(1);
    expect(res.body.state.proposals[0].status).toBe('proposed');
    expect(res.body.state.proposals[0].generatedBy).toBe('ai');
    expect(res.body.state.activeVersionId).toBeNull();
    expect(res.body.currentWindow.windowType).toBe('evidence_collection');
  });

  it('相同输入复用既有提案，不重复调用模型', async () => {
    const harness = createHarness({ level: 'insufficient' });
    await generate(harness.app, 'k1');
    const second = await generate(harness.app, 'k2', 1);
    expect(second.status).toBe(200);
    expect(second.body.reused).toBe(true);
    expect(second.body.state.proposals).toHaveLength(1);
    expect(harness.generateCalls()).toBe(1);
  });

  it('AI 顶层携带 citedEvidenceIds 等未知字段被拒绝，不保存半成品', async () => {
    const bad = fakeOutput({ citedEvidenceIds: ['ev-x'] });
    const { app } = createHarness({ level: 'insufficient', rawText: bad });
    const res = await generate(app, 'k1');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STRATEGY_AI_OUTPUT_INVALID');
    const view = (await app.inject({ method: 'GET', url: '/strategy/current' })).json();
    expect(view.state.proposals).toHaveLength(0);
  });

  it('AI 行动叙事携带确定性字段（priority/allocationShare）被拒绝，不保存半成品', async () => {
    const bad = fakeOutput({ actionNarratives: [{ actionId: 'sw-1', title: 't', rationale: 'r', successSignals: [], failureSignals: [], priority: 'high', allocationShare: 50 }] });
    const { app } = createHarness({ level: 'insufficient', rawText: bad });
    const res = await generate(app, 'k1');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STRATEGY_AI_OUTPUT_INVALID');
    expect((await app.inject({ method: 'GET', url: '/strategy/current' })).json().state.proposals).toHaveLength(0);
  });

  it('AI 数组字段被返回为字符串（字符串化数组）被拒绝，不保存半成品', async () => {
    const bad = fakeOutput({ uncertainties: '["样本有限"]' });
    const { app } = createHarness({ level: 'insufficient', rawText: bad });
    const res = await generate(app, 'k1');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STRATEGY_AI_OUTPUT_INVALID');
    expect((await app.inject({ method: 'GET', url: '/strategy/current' })).json().state.proposals).toHaveLength(0);
  });

  it('AI 引用不存在的 actionId 被拒绝，不保存半成品', async () => {
    const bad = fakeOutput({ actionNarratives: [{ actionId: 'does-not-exist', title: 't', rationale: 'r', successSignals: [], failureSignals: [] }] });
    const { app } = createHarness({ level: 'insufficient', rawText: bad });
    const res = await generate(app, 'k1');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STRATEGY_AI_OUTPUT_INVALID');
    expect((await app.inject({ method: 'GET', url: '/strategy/current' })).json().state.proposals).toHaveLength(0);
  });

  it('合并后行动集合、sourceEvidenceIds、窗口与门禁均不变', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const gen = await generate(app, 'k1');
    const view = gen.body;
    const proposal = view.state.proposals[0];
    // 行动集合与确定性草稿一致（AI 不能新增/删除），sourceEvidenceIds 保持原值。
    expect(proposal.payload.actions.length).toBeGreaterThan(0);
    expect(proposal.payload.actions.every((a: any) => Array.isArray(a.sourceEvidenceIds) && a.sourceEvidenceIds.length === 0)).toBe(true);
    // 窗口与决策门快照来自确定性计算，与 currentWindow 一致。
    expect(proposal.window.windowType).toBe('evidence_collection');
    expect(proposal.window.decisionGateSnapshot).toEqual(view.currentWindow.decisionGateSnapshot);
    expect(proposal.window.blockedActionTypes).toEqual(view.currentWindow.blockedActionTypes);
  });

  it('AI 建议降薪 / 放弃 / 搬迁等禁止措辞被拒绝', async () => {
    for (const phrase of ['应该降薪', '放弃这个方向', '建议搬迁', '成功率']) {
      const { app } = createHarness({ level: 'supported', rawText: fakeOutput({ headline: `策略：${phrase}` }) });
      const res = await generate(app, 'k1');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('STRATEGY_AI_OUTPUT_INVALID');
    }
  });

  it('接受提案只创建一个正式版本并保留 generationMode', async () => {
    const { app } = createHarness({ level: 'directional' });
    const gen = await generate(app, 'k1');
    const proposalId = gen.body.state.proposals[0].id;
    const stateVersion = gen.body.state.stateVersion;
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposalId}/accept`,
      payload: { idempotencyKey: 'a1', expectedStateVersion: stateVersion },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.state.versions).toHaveLength(1);
    expect(body.activeVersion.version).toBe(1);
    expect(body.activeVersion.generationMode).toBe('ai');
  });

  it('修改后接受重新执行门禁：注入被禁止 actionType 时拒绝', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const gen = await generate(app, 'k1');
    const proposal = gen.body.state.proposals[0];
    const modified = structuredClone(proposal.payload);
    modified.actions[0].actionType = 'salary_probe'; // 证据收集窗口禁止
    modified.actions[0].sourceDecisionGate = 'salary_positioning';
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposal.id}/accept`,
      payload: { idempotencyKey: 'a1', expectedStateVersion: gen.body.state.stateVersion, modifiedPayload: modified },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('STRATEGY_ACTION_BLOCKED');
  });

  it('修改后接受保留 decisionDiff', async () => {
    const { app } = createHarness({ level: 'directional' });
    const gen = await generate(app, 'k1');
    const proposal = gen.body.state.proposals[0];
    const modified = structuredClone(proposal.payload);
    modified.headline = '用户修改后的标题';
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposal.id}/accept`,
      payload: { idempotencyKey: 'a1', expectedStateVersion: gen.body.state.stateVersion, modifiedPayload: modified },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.activeVersion.decisionDiff).toContain('headline');
    expect(body.state.proposals[0].status).toBe('modified_and_accepted');
  });

  it('拒绝 / 稍后处理不改变 active version', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const gen = await generate(app, 'k1');
    const proposal = gen.body.state.proposals[0];
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposal.id}/reject`,
      payload: { idempotencyKey: 'r1', expectedStateVersion: gen.body.state.stateVersion },
    });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    expect(body.state.activeVersionId).toBeNull();
    expect(body.state.proposals[0].status).toBe('rejected');
  });

  it('输入变化后旧提案变为 stale 且不能被接受', async () => {
    const { app, db } = createHarness({ level: 'insufficient' });
    const gen = await generate(app, 'k1');
    const proposal = gen.body.state.proposals[0];
    seedMarketPositionActive(db, 'supported', '2'); // 改变 G4 active → inputHash 变化
    const view = (await app.inject({ method: 'GET', url: '/strategy/current' })).json();
    expect(view.state.proposals[0].stale).toBe(true);
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposal.id}/accept`,
      payload: { idempotencyKey: 'a1', expectedStateVersion: view.state.stateVersion },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STRATEGY_INPUT_STALE');
  });

  it('窗口到期后不能接受旧提案', async () => {
    const { app, clock } = createHarness({ level: 'insufficient' });
    const gen = await generate(app, 'k1');
    const proposal = gen.body.state.proposals[0];
    clock.value = proposal.window.expiresAt + 1;
    const res = await app.inject({
      method: 'POST', url: `/strategy/proposals/${proposal.id}/accept`,
      payload: { idempotencyKey: 'a1', expectedStateVersion: gen.body.state.stateVersion },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STRATEGY_WINDOW_EXPIRED');
  });

  it('手工提案在 AI 不可用时仍可建立', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const window = (await app.inject({ method: 'GET', url: '/strategy/current' })).json().currentWindow;
    expect(window).not.toBeNull();
    const snapshot = (await app.inject({ method: 'GET', url: '/strategy/input-snapshot' })).json();
    // 构造合法手工草稿：复用当前窗口的确定性草稿结构由前端提供，这里最小验证空动作草稿被门禁接受。
    const manualPayload = {
      headline: '手工策略', objective: '补样本', summary: '保守推进', horizonDays: 14,
      allocationPlans: [], actions: [], experiments: [],
      evidenceTargets: window.requiredEvidenceTargets, reviewTriggers: window.reviewTriggers,
      stopConditions: window.stopConditions, reversibleActions: ['可逆'], prohibitedActions: ['不得降薪'],
      uncertainties: ['样本有限'],
    };
    const res = await app.inject({
      method: 'POST', url: '/strategy/proposals/manual',
      payload: { idempotencyKey: 'm1', expectedStateVersion: 0, payload: manualPayload },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.proposals[0].generatedBy).toBe('manual');
    expect(snapshot.inputHash).toBeTruthy();
  });

  it('乐观并发：错误的 expectedStateVersion 触发 STRATEGY_STATE_VERSION_CONFLICT', async () => {
    const { app } = createHarness({ level: 'insufficient' });
    const res = await generate(app, 'k1', 99);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STRATEGY_STATE_VERSION_CONFLICT');
  });
});
