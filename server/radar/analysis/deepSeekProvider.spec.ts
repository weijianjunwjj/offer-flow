/**
 * V8-4 生产分析 Provider 测试。mock server/llm/provider 的 chatCompletion：
 * 不访问外网、不读真实配置。断言 retryMax=0、错误映射、取消优先、无泄漏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.hoisted(() => vi.fn());

vi.mock('../../llm/provider', () => ({
  chatCompletion: chatMock,
  getLlmConfig: () => ({ baseUrl: 'https://fake', apiKey: 'k', model: 'deepseek-chat' }),
  isLlmConfigured: () => true,
}));

import { deepSeekJobMatchAnalysisProvider as provider } from './deepSeekProvider';
import { AnalysisProviderError } from './provider';
import { minimalValidPayloadJson } from './analysisProviderFakes';
import { validSnapshot } from './contractFixtures';
import { parseJobMatchAnalysisInputSnapshot } from './contracts';
import { buildJobMatchAnalysisLlmInput } from './llmInput';

const llmInput = buildJobMatchAnalysisLlmInput(parseJobMatchAnalysisInputSnapshot(validSnapshot())).llmInput;

afterEach(() => {
  chatMock.mockReset();
});

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error('expected AnalysisProviderError');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisProviderError);
    expect((error as AnalysisProviderError).code).toBe(code);
  }
}

describe('deepSeekJobMatchAnalysisProvider', () => {
  it('generate passes explicit retryMax:0 and low temperature, returns provider/model', async () => {
    chatMock.mockResolvedValue({ rawText: minimalValidPayloadJson(), model: 'deepseek-chat' });
    const result = await provider.generate(llmInput);
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-chat');
    const [, , options] = chatMock.mock.calls[0]!;
    expect(options.retryMax).toBe(0);
    expect(options.temperature).toBeLessThanOrEqual(0.2);
  });

  it('repair also uses retryMax:0', async () => {
    chatMock.mockResolvedValue({ rawText: minimalValidPayloadJson(), model: 'deepseek-chat' });
    await provider.repair(llmInput, 'prev', 'summary');
    const [, , options] = chatMock.mock.calls[0]!;
    expect(options.retryMax).toBe(0);
  });

  it('maps timeout / rate-limit / network / config errors safely', async () => {
    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 调用超时，请稍后重试' });
    await expectCode(() => provider.generate(llmInput), 'PROVIDER_TIMEOUT');

    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 调用失败 (HTTP 429): rate limited' });
    await expectCode(() => provider.generate(llmInput), 'PROVIDER_RATE_LIMIT');

    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 调用失败 (HTTP 500): boom' });
    await expectCode(() => provider.generate(llmInput), 'PROVIDER_NETWORK_ERROR');

    chatMock.mockResolvedValue({ rawText: '', model: 'unknown', error: 'LLM 未配置：缺少环境变量 API_KEY' });
    await expectCode(() => provider.generate(llmInput), 'CONFIGURATION_ERROR');
  });

  it('treats aborted signal as CANCELLED_BY_USER even if provider reports timeout', async () => {
    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 调用超时' });
    const controller = new AbortController();
    controller.abort();
    await expectCode(() => provider.generate(llmInput, controller.signal), 'CANCELLED_BY_USER');
  });

  it('never leaks provider response body / HTTP text in error message', async () => {
    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 调用失败 (HTTP 500): secret-upstream-body-xyz' });
    try {
      await provider.generate(llmInput);
      throw new Error('expected throw');
    } catch (error) {
      expect((error as AnalysisProviderError).message).not.toContain('secret-upstream-body-xyz');
    }
  });

  it('generate & repair disable thinking (推理模型思维链会挤占 max_tokens 致答案截断)', async () => {
    chatMock.mockResolvedValue({ rawText: minimalValidPayloadJson(), model: 'deepseek-v4-flash', finishReason: 'stop' });
    await provider.generate(llmInput);
    expect(chatMock.mock.calls[0]![2].disableThinking).toBe(true);
    chatMock.mockClear();
    await provider.repair(llmInput, 'prev', 'summary');
    expect(chatMock.mock.calls[0]![2].disableThinking).toBe(true);
  });

  it('requests a max_tokens large enough for reasoning + JSON answer (8192)', async () => {
    // 根因回归：推理模型 reasoning_content 与 content 共享 max_tokens，4096 被思维链吃光 →
    // content 空 → JSON 非法。预算必须足以同时容纳推理与答案。
    chatMock.mockResolvedValue({ rawText: minimalValidPayloadJson(), model: 'deepseek-chat', finishReason: 'stop' });
    await provider.generate(llmInput);
    const [, , options] = chatMock.mock.calls[0]!;
    expect(options.maxTokens).toBe(8192);
  });

  it('maps truncation (finish_reason=length) to a diagnosable error, prioritized over empty-content', async () => {
    // 截断（推理吃光预算 → content 空）此前落泛化「返回空内容」，无法定位。现给出稳定语义。
    chatMock.mockResolvedValue({ rawText: '', model: 'deepseek-chat', error: 'LLM 返回空内容', finishReason: 'length' });
    try {
      await provider.generate(llmInput);
      throw new Error('expected throw');
    } catch (error) {
      const err = error as AnalysisProviderError;
      expect(err.code).toBe('PROVIDER_NETWORK_ERROR');
      expect(err.message).toContain('max_tokens');
      expect(err.message).toContain('finish_reason=length');
      expect(err.detail).toBe('finish_reason=length');
    }
  });

  it('aborted signal still wins over truncation classification', async () => {
    chatMock.mockResolvedValue({ rawText: '', model: 'm', error: 'LLM 返回空内容', finishReason: 'length' });
    const controller = new AbortController();
    controller.abort();
    await expectCode(() => provider.generate(llmInput, controller.signal), 'CANCELLED_BY_USER');
  });
});
