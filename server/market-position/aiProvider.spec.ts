import { describe, expect, it, vi } from 'vitest';
import { MARKET_POSITION_CITY_CODES } from '../../src/domain/market-position';
import { MarketPositionError } from './errors';

const mocks = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
  getLlmConfig: vi.fn(() => ({ baseUrl: 'https://fake', apiKey: 'k', model: 'fake-model' })),
  isLlmConfigured: vi.fn(() => true),
}));

vi.mock('../llm/provider', () => ({
  chatCompletion: mocks.chatCompletion,
  getLlmConfig: mocks.getLlmConfig,
  isLlmConfigured: mocks.isLlmConfigured,
}));

async function importFresh() {
  return import('./aiProvider');
}

function narrative(overrides: Record<string, unknown> = {}) {
  return {
    headline: '当前样本有限，证据不足，尚待验证。',
    positioning: '已积累一定投递样本，但缺少有效回复与面试，暂不能判断市场定位。',
    observedStrengths: [],
    observedWeaknesses: [],
    marketSignals: [],
    counterSignals: [],
    uncertainties: ['样本量不足以支持任何城市或薪资结论'],
    nextEvidenceActions: ['继续投递并观察回复情况'],
    citedEvidenceIds: [],
    ...overrides,
  };
}

function validAiOutput(overrides: { globalOverrides?: Record<string, unknown>; cityOverrides?: Record<string, unknown> } = {}) {
  return {
    global: narrative(overrides.globalOverrides),
    cityProfiles: MARKET_POSITION_CITY_CODES.map((city) => ({
      city,
      ...narrative(overrides.cityOverrides),
    })),
  };
}

describe('parseMarketPositionAiOutput · 结构 / 禁止措辞 / 证据引用校验', () => {
  it('合法输出通过校验', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const result = parseMarketPositionAiOutput(JSON.stringify(validAiOutput()), []);
    expect('data' in result).toBe(true);
  });

  it('非法 JSON 被拒绝', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const result = parseMarketPositionAiOutput('不是 JSON', []);
    expect('error' in result).toBe(true);
  });

  it('缺少城市或城市重复：结构校验失败', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output = validAiOutput();
    output.cityProfiles = output.cityProfiles.filter((c) => c.city !== 'hangzhou');
    const result = parseMarketPositionAiOutput(JSON.stringify(output), []);
    expect('error' in result).toBe(true);
  });

  it('输出中携带确定性字段（如 evidenceLevel）：因未知字段被 strictObject 拒绝', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output: Record<string, unknown> = validAiOutput();
    (output.global as Record<string, unknown>).evidenceLevel = 'supported';
    const result = parseMarketPositionAiOutput(JSON.stringify(output), []);
    expect('error' in result).toBe(true);
  });

  it('命中禁止措辞（如"市场不认可"）：结构错误', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output = validAiOutput({ globalOverrides: { headline: '市场不认可你的定位' } });
    const result = parseMarketPositionAiOutput(JSON.stringify(output), []);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('市场不认可');
  });

  it('命中禁止措辞（如"0%回复率"类的"回复率"字样）：结构错误', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output = validAiOutput({ globalOverrides: { positioning: '当前回复率为 0%' } });
    const result = parseMarketPositionAiOutput(JSON.stringify(output), []);
    expect('error' in result).toBe(true);
  });

  it('引用了不存在的证据 id：结构错误', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output = validAiOutput({ globalOverrides: { citedEvidenceIds: ['evidence-not-exist'] } });
    const result = parseMarketPositionAiOutput(JSON.stringify(output), ['evidence-real-1']);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('证据');
  });

  it('引用的证据 id 在允许清单中：通过校验', async () => {
    const { parseMarketPositionAiOutput } = await importFresh();
    const output = validAiOutput({ globalOverrides: { citedEvidenceIds: ['evidence-real-1'] } });
    const result = parseMarketPositionAiOutput(JSON.stringify(output), ['evidence-real-1']);
    expect('data' in result).toBe(true);
  });
});

describe('deepSeekMarketPositionProvider · 一次修复后失败即报错', () => {
  it('首次输出合法：只调用一次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ rawText: JSON.stringify(validAiOutput()), model: 'fake-model' });
    const { deepSeekMarketPositionProvider } = await importFresh();
    const result = await deepSeekMarketPositionProvider.generate({ acceptedEvidenceIds: [], global: emptyFacts('global'), cityProfiles: [] });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    expect(result.model).toBe('fake-model');
  });

  it('首次非法、第二次修复成功：恰好调用两次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: '{"bad":"structure"}', model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: JSON.stringify(validAiOutput()), model: 'fake-model' });
    const { deepSeekMarketPositionProvider } = await importFresh();
    const result = await deepSeekMarketPositionProvider.generate({ acceptedEvidenceIds: [], global: emptyFacts('global'), cityProfiles: [] });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.model).toBe('fake-model');
  });

  it('连续两次非法：恰好调用两次后抛出 MARKET_POSITION_AI_OUTPUT_INVALID，不再重试', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ rawText: '{"bad":"structure"}', model: 'fake-model' });
    const { deepSeekMarketPositionProvider } = await importFresh();
    let caught: MarketPositionError | undefined;
    try {
      await deepSeekMarketPositionProvider.generate({ acceptedEvidenceIds: [], global: emptyFacts('global'), cityProfiles: [] });
    } catch (error) {
      caught = error as MarketPositionError;
    }
    expect(caught).toBeInstanceOf(MarketPositionError);
    expect(caught?.code).toBe('MARKET_POSITION_AI_OUTPUT_INVALID');
    expect(caught?.details.attempts).toBe(2);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('Provider 级错误（超时/网络失败）不会进入结构修复：只调用一次，映射为 MARKET_POSITION_AI_UNAVAILABLE', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ rawText: '', model: 'fake-model', error: 'LLM 调用超时，请稍后重试' });
    const { deepSeekMarketPositionProvider } = await importFresh();
    await expect(
      deepSeekMarketPositionProvider.generate({ acceptedEvidenceIds: [], global: emptyFacts('global'), cityProfiles: [] }),
    ).rejects.toMatchObject({ code: 'MARKET_POSITION_AI_UNAVAILABLE' });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('未配置时 isConfigured 返回 false', async () => {
    mocks.isLlmConfigured.mockReturnValue(false);
    const { deepSeekMarketPositionProvider } = await importFresh();
    expect(deepSeekMarketPositionProvider.isConfigured()).toBe(false);
    mocks.isLlmConfigured.mockReturnValue(true);
  });
});

function emptyFacts(scopeLabel: string) {
  return {
    scopeLabel,
    city: null,
    evidenceLevel: 'insufficient',
    allowedClaims: [],
    blockedClaims: [],
    applicationCount: 0,
    companyCount: 0,
    validReplyCount: 0,
    interviewCount: 0,
    terminalOutcomeCount: 0,
    hasAnyEvidence: false,
  };
}
