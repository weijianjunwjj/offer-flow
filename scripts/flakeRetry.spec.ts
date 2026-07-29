import { describe, expect, it, vi } from 'vitest';
import { isTransientFlake, withFlakeRetry } from './flakeRetry';
import { AnalysisProviderError } from '../server/radar/analysis/provider';
import type { JobMatchAnalysisProvider } from '../server/radar/analysis/provider';
import type { JobMatchAnalysisLlmInputV1 } from '../server/radar/analysis/llmContracts';

const OK = { rawText: '{}', provider: 'p', model: 'm' } as const;
const INPUT = {} as unknown as JobMatchAnalysisLlmInputV1;

/** 构造一个 generate 按脚本给定序列抛错/成功的假 Provider，记录调用次数。 */
function providerFrom(seq: Array<Error | typeof OK>): JobMatchAnalysisProvider & { calls: () => number } {
  let i = 0;
  return {
    isConfigured: () => true,
    providerName: () => 'p',
    modelName: () => 'm',
    calls: () => i,
    generate: async () => {
      const step = seq[i]; i += 1;
      if (step instanceof Error) throw step;
      return step!;
    },
    repair: async () => OK,
  };
}

const connectTimeout = () => new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 网络调用失败');
const truncation = () => new AnalysisProviderError('PROVIDER_NETWORK_ERROR', '模型响应被 max_tokens 截断', 'finish_reason=length');

describe('isTransientFlake — 仅连接层抖动算 flake', () => {
  it('connect timeout / fetch failed / 网络调用失败 / 超时 → flake', () => {
    expect(isTransientFlake(connectTimeout())).toBe(true);
    expect(isTransientFlake(new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'fetch failed'))).toBe(true);
    expect(isTransientFlake(new AnalysisProviderError('PROVIDER_TIMEOUT', 'Provider 调用超时'))).toBe(true);
  });

  it('截断 / 空内容 / HTTP 状态 / 限流 / 配置 / 取消 → 非 flake', () => {
    expect(isTransientFlake(truncation())).toBe(false);
    expect(isTransientFlake(new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 返回空内容'))).toBe(false);
    expect(isTransientFlake(new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 返回错误状态（HTTP 500）'))).toBe(false);
    expect(isTransientFlake(new AnalysisProviderError('PROVIDER_RATE_LIMIT', 'Provider 触发限流（HTTP 429）'))).toBe(false);
    expect(isTransientFlake(new AnalysisProviderError('CONFIGURATION_ERROR', 'LLM 未配置'))).toBe(false);
    expect(isTransientFlake(new AnalysisProviderError('CANCELLED_BY_USER', '分析已被用户取消'))).toBe(false);
  });

  it('非 AnalysisProviderError → 非 flake', () => {
    expect(isTransientFlake(new Error('boom'))).toBe(false);
    expect(isTransientFlake('nope')).toBe(false);
  });
});

describe('withFlakeRetry — 有界重试 flake、确定性失败立即冒泡', () => {
  it('穿越若干次 flake 后成功（不超过上限）', async () => {
    const p = providerFrom([connectTimeout(), connectTimeout(), OK]);
    const onRetry = vi.fn();
    const wrapped = withFlakeRetry(p, 5, onRetry);
    await expect(wrapped.generate(INPUT)).resolves.toEqual(OK);
    expect(p.calls()).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('flake 次数超过上限 → 抛最后一次 flake', async () => {
    const p = providerFrom([connectTimeout(), connectTimeout(), connectTimeout()]);
    const wrapped = withFlakeRetry(p, 1, vi.fn()); // 1 次重试 = 最多 2 次调用
    await expect(wrapped.generate(INPUT)).rejects.toBeInstanceOf(AnalysisProviderError);
    expect(p.calls()).toBe(2);
  });

  it('确定性失败（截断）→ 不重试，立即冒泡', async () => {
    const p = providerFrom([truncation(), OK]);
    const onRetry = vi.fn();
    const wrapped = withFlakeRetry(p, 5, onRetry);
    await expect(wrapped.generate(INPUT)).rejects.toMatchObject({ detail: 'finish_reason=length' });
    expect(p.calls()).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries=0 → 等价不包装（首次 flake 即冒泡）', async () => {
    const p = providerFrom([connectTimeout(), OK]);
    const wrapped = withFlakeRetry(p, 0);
    await expect(wrapped.generate(INPUT)).rejects.toBeInstanceOf(AnalysisProviderError);
    expect(p.calls()).toBe(1);
  });

  it('首次成功 → 只调用一次', async () => {
    const p = providerFrom([OK]);
    const wrapped = withFlakeRetry(p, 5);
    await expect(wrapped.generate(INPUT)).resolves.toEqual(OK);
    expect(p.calls()).toBe(1);
  });
});
