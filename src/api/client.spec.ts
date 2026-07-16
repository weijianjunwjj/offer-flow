import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiNetworkError, apiGet } from './client';

describe('可取消读取 API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('将 signal 传递给 fetch', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    await apiGet('/health', { signal: controller.signal });
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('保留 AbortError，不包装为 ApiError', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
    await expect(apiGet('/jobs')).rejects.toBe(abortError);
  });

  it('非 2xx 仍产生 ApiError，旧调用无需 options', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('missing', { status: 404 })));
    await expect(apiGet('/jobs/missing')).rejects.toMatchObject({ status: 404 } satisfies Partial<ApiError>);
  });

  it('连接被拒绝（fetch 抛出 TypeError）时包装为 ApiNetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiGet('/health')).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('保留结构化错误体供领域适配器按 code 决策', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'VERSION_CONFLICT',
      message: '不要解析这段文本',
      currentVersion: 3,
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })));
    await expect(apiGet('/resume-versions')).rejects.toMatchObject({
      status: 409,
      body: { code: 'VERSION_CONFLICT', currentVersion: 3 },
    } satisfies Partial<ApiError>);
  });
});
