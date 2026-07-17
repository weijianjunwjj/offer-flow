import { afterEach, describe, expect, it, vi } from 'vitest';

const llmMock = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
vi.mock('../llm/provider', () => ({
  chatCompletion: llmMock.chatCompletion,
  isLlmConfigured: () => true,
  getLlmConfig: () => ({ model: 'fake-model' }),
}));

import {
  deepSeekStrategyProvider,
  parseStrategyAiOutput,
  type StrategyAiInputSnapshot,
} from './aiProvider';
import { StrategyError } from './errors';

const ACTION_IDS = ['sa-1', 'sa-2'];

function snapshot(): StrategyAiInputSnapshot {
  return {
    windowType: 'evidence_collection',
    evidenceLevel: 'insufficient',
    allowedActionTypes: ['collect_market_evidence', 'increase_reliable_applications'],
    observeOnlyActionTypes: [],
    blockedActionTypes: ['salary_probe'],
    allowedClaims: [], blockedClaims: [],
    reviewTriggers: ['14 天到期'], stopConditions: ['出现不可逆后果时停止'],
    actionTargets: [
      { actionId: 'sa-1', actionType: 'collect_market_evidence', title: '补充市场证据' },
      { actionId: 'sa-2', actionType: 'increase_reliable_applications', title: '增加可靠投递样本' },
    ],
  };
}

function goodOutput(): string {
  return JSON.stringify({
    headline: 'AI 策略标题',
    objective: '补充样本',
    summary: '保守推进，等待人工审核',
    uncertainties: ['样本有限'],
    actionNarratives: ACTION_IDS.map((actionId) => ({
      actionId, title: '行动标题', rationale: '理由', successSignals: ['正向信号'], failureSignals: ['负向信号'],
    })),
  });
}

afterEach(() => { llmMock.chatCompletion.mockReset(); });

describe('deepSeekStrategyProvider 修复流程', () => {
  it('首次含额外字段 citedEvidenceIds，修复后成功（恰好两次请求）', async () => {
    const bad = JSON.stringify({ ...JSON.parse(goodOutput()), citedEvidenceIds: ['ev-1'] });
    llmMock.chatCompletion
      .mockResolvedValueOnce({ rawText: bad, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: goodOutput(), model: 'fake-model' });
    const result = await deepSeekStrategyProvider.generate(snapshot());
    expect(result.rawText).toBe(goodOutput());
    expect(llmMock.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('首次数组被返回为字符串，修复后成功（恰好两次请求）', async () => {
    const bad = JSON.stringify({ ...JSON.parse(goodOutput()), uncertainties: '["样本有限"]' });
    llmMock.chatCompletion
      .mockResolvedValueOnce({ rawText: bad, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: goodOutput(), model: 'fake-model' });
    const result = await deepSeekStrategyProvider.generate(snapshot());
    expect(result.rawText).toBe(goodOutput());
    expect(llmMock.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('连续两次字符串化数组仍失败：抛 STRATEGY_AI_OUTPUT_INVALID，不发起第三次请求', async () => {
    const bad = JSON.stringify({ ...JSON.parse(goodOutput()), successSignals: undefined, uncertainties: '"x"' });
    llmMock.chatCompletion.mockResolvedValue({ rawText: bad, model: 'fake-model' });
    await expect(deepSeekStrategyProvider.generate(snapshot())).rejects.toMatchObject({
      code: 'STRATEGY_AI_OUTPUT_INVALID',
    });
    expect(llmMock.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('模型层错误映射为 STRATEGY_AI_UNAVAILABLE', async () => {
    llmMock.chatCompletion.mockResolvedValue({ error: '调用超时' });
    await expect(deepSeekStrategyProvider.generate(snapshot())).rejects.toBeInstanceOf(StrategyError);
  });
});

describe('parseStrategyAiOutput 守卫', () => {
  it('合法 overlay 通过', () => {
    expect('data' in parseStrategyAiOutput(goodOutput(), ACTION_IDS)).toBe(true);
  });

  it('未知额外字段（citedEvidenceIds）拒绝', () => {
    const bad = JSON.stringify({ ...JSON.parse(goodOutput()), citedEvidenceIds: [] });
    expect('error' in parseStrategyAiOutput(bad, ACTION_IDS)).toBe(true);
  });

  it('行动叙事携带确定性字段（priority）拒绝', () => {
    const parsed = JSON.parse(goodOutput());
    parsed.actionNarratives[0].priority = 'high';
    expect('error' in parseStrategyAiOutput(JSON.stringify(parsed), ACTION_IDS)).toBe(true);
  });

  it('字符串化数组拒绝', () => {
    const parsed = JSON.parse(goodOutput());
    parsed.uncertainties = '["x"]';
    expect('error' in parseStrategyAiOutput(JSON.stringify(parsed), ACTION_IDS)).toBe(true);
  });

  it('未知 actionId 拒绝', () => {
    const parsed = JSON.parse(goodOutput());
    parsed.actionNarratives[0].actionId = 'nope';
    expect('error' in parseStrategyAiOutput(JSON.stringify(parsed), ACTION_IDS)).toBe(true);
  });
});
