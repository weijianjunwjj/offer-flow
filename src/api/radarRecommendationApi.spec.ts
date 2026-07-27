import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { radarRecommendationApi } from './radarRecommendationApi';

const API_BASE = 'http://127.0.0.1:17365';
const CAPTURE_HEADER = 'x-offerflow-capture-client';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function stubFetch(body: unknown = { ok: true }) {
  const spy = vi.fn().mockResolvedValue(okJson(body));
  vi.stubGlobal('fetch', spy);
  return spy;
}
function call(spy: ReturnType<typeof vi.fn>) {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit | undefined];
  return { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body };
}

describe('radarRecommendationApi method/path/headers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('createBatch → POST recommendation-batches，带 scope body 与安全头', async () => {
    const spy = stubFetch();
    await radarRecommendationApi.createBatch(['cv-1', 'cv-2']);
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/recommendation-batches`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(c.body as string)).toEqual({ candidateVersionIds: ['cv-1', 'cv-2'] });
  });

  it('getBatch → GET recommendation-batches/:id（路径编码）', async () => {
    const spy = stubFetch();
    await radarRecommendationApi.getBatch('batch/../x');
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/recommendation-batches/batch%2F..%2Fx`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
  });

  it('listRecentBatches → GET recommendation-batches', async () => {
    const spy = stubFetch([]);
    await radarRecommendationApi.listRecentBatches();
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/recommendation-batches`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
  });

  it('非 2xx 传播为 ApiError，保留后端安全 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'SCOPE_EMPTY', message: '推荐 scope 不能为空' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(radarRecommendationApi.createBatch([])).rejects.toMatchObject({
      status: 400, message: '推荐 scope 不能为空',
    } satisfies Partial<ApiError>);
  });

  it('404 未找到同样传播 ApiError（供面板区分）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'BATCH_NOT_FOUND', message: '推荐批次不存在' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(radarRecommendationApi.getBatch('nope')).rejects.toMatchObject({ status: 404 });
  });
});
