import { describe, expect, it, vi } from 'vitest';
import { makeJobMatchProfileDraftFixture } from '../../src/domain/job-match-profile/testFixtures';
import { JobMatchProfileError } from './errors';

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

const legacyStructureRawText = JSON.stringify({
  profileSummary: '旧结构',
  overallAssessment: '旧结构',
  cityProfiles: [
    {
      city: 'suzhou',
      marketPosition: '旧结构',
      salaryRange: '旧结构',
      riskLevel: '旧结构',
      recommendation: '旧结构',
    },
  ],
});

describe('AI Provider 错误分类', () => {
  it('result.error 包含超时信息 → AI_PROVIDER_TIMEOUT', async () => {
    mocks.chatCompletion.mockResolvedValue({
      rawText: '', model: 'fake-model', error: 'LLM 调用超时，请稍后重试或缩短 JD / Prompt',
    });
    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await expect(deepSeekJobMatchProfileProvider.generate(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
  });

  it('HTTP 失败 / 网络异常等 Provider 失败 → AI_PROVIDER_UNAVAILABLE', async () => {
    mocks.chatCompletion.mockResolvedValue({
      rawText: '', model: 'fake-model', error: 'LLM 调用失败 (HTTP 500): 内部错误',
    });
    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await expect(deepSeekJobMatchProfileProvider.generate(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  it('空响应 / 网络异常字样也归类为 AI_PROVIDER_UNAVAILABLE', async () => {
    mocks.chatCompletion.mockResolvedValue({
      rawText: '', model: 'fake-model', error: 'LLM 调用异常: fetch failed',
    });
    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await expect(deepSeekJobMatchProfileProvider.generate(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  it('模型返回内容无法解析为 JSON → AI_STRUCTURED_OUTPUT_INVALID', async () => {
    const { parseJobMatchProfileAiOutput } = await importFresh();
    expect(() => parseJobMatchProfileAiOutput('不是 JSON'))
      .toThrow(JobMatchProfileError);
    try {
      parseJobMatchProfileAiOutput('不是 JSON');
    } catch (error) {
      expect((error as JobMatchProfileError).code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    }
  });

  it('模型返回内容不符合 Draft Schema → AI_STRUCTURED_OUTPUT_INVALID', async () => {
    const { parseJobMatchProfileAiOutput } = await importFresh();
    expect(() => parseJobMatchProfileAiOutput('{"not":"a valid draft"}'))
      .toThrow(JobMatchProfileError);
    try {
      parseJobMatchProfileAiOutput('{"not":"a valid draft"}');
    } catch (error) {
      expect((error as JobMatchProfileError).code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    }
  });

  it('合法 Draft 输出正常解析', async () => {
    const { parseJobMatchProfileAiOutput } = await importFresh();
    const draft = makeJobMatchProfileDraftFixture();
    expect(() => parseJobMatchProfileAiOutput(JSON.stringify(draft))).not.toThrow();
  });

  it('Provider 未配置继续使用 AI_PROVIDER_NOT_CONFIGURED（由 service 层判定，不在 Provider 内部）', async () => {
    mocks.isLlmConfigured.mockReturnValue(false);
    const { deepSeekJobMatchProfileProvider } = await importFresh();
    expect(deepSeekJobMatchProfileProvider.isConfigured()).toBe(false);
    mocks.isLlmConfigured.mockReturnValue(true);
  });
});

describe('AI 输出结构修复（最多一次）', () => {
  it('首次输出即合法：只调用一次，结果通过 Schema', async () => {
    mocks.chatCompletion.mockReset();
    const draft = makeJobMatchProfileDraftFixture();
    mocks.chatCompletion.mockResolvedValue({ rawText: JSON.stringify(draft), model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider, parseJobMatchProfileAiOutput } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    const result = await deepSeekJobMatchProfileProvider.generate(snapshot);

    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    expect(() => parseJobMatchProfileAiOutput(result.rawText)).not.toThrow();
  });

  it('首次为旧结构，第二次修复成功：恰好调用两次，第二次 Prompt 含 fieldErrors 与完整模板', async () => {
    mocks.chatCompletion.mockReset();
    const draft = makeJobMatchProfileDraftFixture();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyStructureRawText, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: JSON.stringify(draft), model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider, parseJobMatchProfileAiOutput } = await importFresh();
    const snapshot = { snapshot: { marker: 'repair-test' } } as never;
    const result = await deepSeekJobMatchProfileProvider.generate(snapshot);

    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
    const secondCallArgs = mocks.chatCompletion.mock.calls[1];
    const secondUserMessage = secondCallArgs?.[1] as string;
    expect(secondUserMessage).toContain('fieldErrors');
    expect(secondUserMessage).toContain('northStarPositioning');
    expect(secondUserMessage).toContain('不得新增输入快照中不存在的事实');
    expect(() => parseJobMatchProfileAiOutput(result.rawText)).not.toThrow();
  });

  it('连续两次结构错误：恰好调用两次，不再调用第三次，抛出 AI_STRUCTURED_OUTPUT_INVALID 且不产生提案', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyStructureRawText, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: legacyStructureRawText, model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;

    let caught: JobMatchProfileError | undefined;
    try {
      await deepSeekJobMatchProfileProvider.generate(snapshot);
    } catch (error) {
      caught = error as JobMatchProfileError;
    }
    expect(caught).toBeInstanceOf(JobMatchProfileError);
    expect(caught?.code).toBe('AI_STRUCTURED_OUTPUT_INVALID');
    expect(caught?.message).toBe('AI 连续两次未能生成符合岗位画像协议的内容，请重新生成或使用手工提案');
    expect(caught?.details.fieldErrors).toBeDefined();
    expect(caught?.details.attempts).toBe(2);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('Provider 级错误（超时 / 网络失败）不会进入结构修复：只调用一次，保留原始错误分类', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({
      rawText: '', model: 'fake-model', error: 'LLM 调用超时，请稍后重试或缩短 JD / Prompt',
    });

    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;

    await expect(deepSeekJobMatchProfileProvider.generate(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('AI 输出契约完整性', () => {
  it('首次系统 Prompt 包含当前 Draft 结构关键字段与旧字段禁用清单', async () => {
    mocks.chatCompletion.mockReset();
    const draft = makeJobMatchProfileDraftFixture();
    mocks.chatCompletion.mockResolvedValue({ rawText: JSON.stringify(draft), model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await deepSeekJobMatchProfileProvider.generate(snapshot);

    const firstSystemPrompt = mocks.chatCompletion.mock.calls[0]?.[0] as string;
    const requiredFields = [
      'northStarPositioning', 'highestReachableRole', 'primaryRoleFamilies',
      'stretchRoles', 'primaryRoles', 'safeRoles', 'coreCapabilities', 'constraints',
      'idealEnvironment', 'acceptableRange', 'cityProfiles', 'supportingEvidence',
      'counterEvidence', 'confidence', 'largestUncertainties',
      'suzhou', 'wuxi', 'shanghai', 'hangzhou',
    ];
    for (const field of requiredFields) {
      expect(firstSystemPrompt).toContain(field);
    }
    const legacyFields = [
      'profileSummary', 'overallAssessment', 'careerStrategy', 'evidenceSummary',
      'recommendation', 'marketPosition', 'riskLevel',
    ];
    for (const field of legacyFields) {
      expect(firstSystemPrompt).toContain(field);
    }
  });

  it('首次系统 Prompt 含数组元素字段规格，并显式禁止 constraints 使用 description/category/impact', async () => {
    mocks.chatCompletion.mockReset();
    const draft = makeJobMatchProfileDraftFixture();
    mocks.chatCompletion.mockResolvedValue({ rawText: JSON.stringify(draft), model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await deepSeekJobMatchProfileProvider.generate(snapshot);

    const firstSystemPrompt = mocks.chatCompletion.mock.calls[0]?.[0] as string;
    // constraints 元素字段签名
    expect(firstSystemPrompt).toContain('evidenceRefs');
    expect(firstSystemPrompt).toContain('description / category / impact');
    // 能力 level 与证据枚举取值
    expect(firstSystemPrompt).toContain('to_validate');
    expect(firstSystemPrompt).toContain('neutral');
    expect(firstSystemPrompt).toContain('borrowedEvidence');
    expect(firstSystemPrompt).toContain('salaryRange');
  });

  it('修复调用 Prompt 同样携带数组元素字段规格', async () => {
    mocks.chatCompletion.mockReset();
    const draft = makeJobMatchProfileDraftFixture();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyStructureRawText, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: JSON.stringify(draft), model: 'fake-model' });

    const { deepSeekJobMatchProfileProvider } = await importFresh();
    const snapshot = { snapshot: {} } as never;
    await deepSeekJobMatchProfileProvider.generate(snapshot);

    const secondUserMessage = mocks.chatCompletion.mock.calls[1]?.[1] as string;
    expect(secondUserMessage).toContain('description / category / impact');
    expect(secondUserMessage).toContain('to_validate');
  });
});
