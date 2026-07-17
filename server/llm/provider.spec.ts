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
