import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './client';

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
});
