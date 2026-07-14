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
