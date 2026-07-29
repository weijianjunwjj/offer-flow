import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('LLM provider · max_tokens 解析', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OFFERFLOW_LLM_BASE_URL = 'https://fake';
    process.env.OFFERFLOW_LLM_API_KEY = 'test-key';
    process.env.OFFERFLOW_LLM_MODEL = 'fake-model';
    delete process.env.OFFERFLOW_LLM_MAX_TOKENS;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function importFresh() {
    return import('./provider');
  }

  function stubFetchCapturingMaxTokens(): { getLastMaxTokens: () => number | undefined } {
    let lastMaxTokens: number | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      lastMaxTokens = body.max_tokens;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return { getLastMaxTokens: () => lastMaxTokens };
  }

  it('显式 options.maxTokens = 8192 优先于 env（即使 env 设为 1800）', async () => {
    process.env.OFFERFLOW_LLM_MAX_TOKENS = '1800';
    const capture = stubFetchCapturingMaxTokens();
    const { chatCompletion } = await importFresh();
    await chatCompletion('system', 'user', { maxTokens: 8192 });
    expect(capture.getLastMaxTokens()).toBe(8192);
  });

  it('未显式传入 maxTokens 时，env 生效', async () => {
    process.env.OFFERFLOW_LLM_MAX_TOKENS = '2400';
    const capture = stubFetchCapturingMaxTokens();
    const { chatCompletion } = await importFresh();
    await chatCompletion('system', 'user');
    expect(capture.getLastMaxTokens()).toBe(2400);
  });

  it('未显式传入 maxTokens 且 env 未设置时，使用默认 1800', async () => {
    const capture = stubFetchCapturingMaxTokens();
    const { chatCompletion } = await importFresh();
    await chatCompletion('system', 'user');
    expect(capture.getLastMaxTokens()).toBe(1800);
  });

  it('显式 options.maxTokens 超出硬上限 8192 时被夹到 8192', async () => {
    const capture = stubFetchCapturingMaxTokens();
    const { chatCompletion } = await importFresh();
    await chatCompletion('system', 'user', { maxTokens: 100000 });
    expect(capture.getLastMaxTokens()).toBe(8192);
  });
});

describe('LLM provider · finish_reason / reasoning_content 映射', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OFFERFLOW_LLM_BASE_URL = 'https://fake';
    process.env.OFFERFLOW_LLM_API_KEY = 'test-key';
    process.env.OFFERFLOW_LLM_MODEL = 'fake-model';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function stubFetchReturning(payload: unknown): void {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
  }

  it('surfaces finish_reason on success', async () => {
    stubFetchReturning({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] });
    const { chatCompletion } = await import('./provider');
    const result = await chatCompletion('system', 'user');
    expect(result.rawText).toBe('{"ok":true}');
    expect(result.finishReason).toBe('stop');
  });

  it('reports empty content + finish_reason=length when reasoning_content ate the budget (truncation root cause)', async () => {
    // 推理模型：content 空，reasoning_content 有内容，finish_reason=length。
    stubFetchReturning({
      choices: [{ message: { content: '', reasoning_content: 'x'.repeat(10000) }, finish_reason: 'length' }],
    });
    const { chatCompletion } = await import('./provider');
    const result = await chatCompletion('system', 'user');
    expect(result.rawText).toBe('');
    expect(result.error).toBe('LLM 返回空内容');
    expect(result.finishReason).toBe('length');
  });

  it('does not treat reasoning_content as the answer (content stays the source of truth)', async () => {
    stubFetchReturning({
      choices: [{ message: { content: '{"real":1}', reasoning_content: 'chain of thought' }, finish_reason: 'stop' }],
    });
    const { chatCompletion } = await import('./provider');
    const result = await chatCompletion('system', 'user');
    expect(result.rawText).toBe('{"real":1}');
  });

  it('invokes onRawResponse with the raw field mapping (for debug tooling only)', async () => {
    stubFetchReturning({
      choices: [{ message: { content: 'C', reasoning_content: 'RRR' }, finish_reason: 'length' }],
    });
    const { chatCompletion } = await import('./provider');
    let captured: unknown;
    await chatCompletion('system', 'user', { onRawResponse: (info) => { captured = info; } });
    expect(captured).toMatchObject({
      httpStatus: 200,
      finishReason: 'length',
      contentLength: 1,
      reasoningContentLength: 3,
      content: 'C',
      reasoningContent: 'RRR',
    });
  });
});

describe('LLM provider · transport retry 上限', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OFFERFLOW_LLM_BASE_URL = 'https://fake';
    process.env.OFFERFLOW_LLM_API_KEY = 'test-key';
    process.env.OFFERFLOW_LLM_MODEL = 'fake-model';
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function importFresh() {
    return import('./provider');
  }

  /** fetch 恒抛可重试错误（'fetch failed'）并计尝试次数。 */
  function stubFetchAlwaysRetryable(): { attempts: () => number } {
    let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempts += 1;
      throw new Error('fetch failed');
    }));
    return { attempts: () => attempts };
  }

  it('显式 retryMax=0 关闭 transport 重试：只尝试一次', async () => {
    delete process.env.OFFERFLOW_LLM_RETRY_MAX;
    const capture = stubFetchAlwaysRetryable();
    const { chatCompletion } = await importFresh();
    const result = await chatCompletion('system', 'user', { retryMax: 0 });
    expect(capture.attempts()).toBe(1);
    expect(result.error).toBeDefined();
  });

  it('未传 retryMax 时沿用 env 默认（env=2 → 3 次尝试），旧行为不变', async () => {
    process.env.OFFERFLOW_LLM_RETRY_MAX = '2';
    const capture = stubFetchAlwaysRetryable();
    const { chatCompletion } = await importFresh();
    vi.useFakeTimers();
    const promise = chatCompletion('system', 'user');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(capture.attempts()).toBe(3);
    expect(result.error).toBeDefined();
  });
});
