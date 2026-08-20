import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, API_BASE } from './client';
import { radarActionApi } from './radarActionApi';

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

describe('radarActionApi method/path/headers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('getView → GET actions/candidates/:id（路径编码 + 安全头）', async () => {
    const spy = stubFetch();
    await radarActionApi.getView('cand/../x');
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/actions/candidates/cand%2F..%2Fx`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
  });

  it('apply → POST actions/apply，带 body 与安全头', async () => {
    const spy = stubFetch();
    await radarActionApi.apply({ candidateId: 'cand-1', family: 'appliedPending', channel: 'boss' });
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/actions/apply`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(c.body as string)).toEqual({ candidateId: 'cand-1', family: 'appliedPending', channel: 'boss' });
  });

  it('revert → POST actions/revert，带 body 与安全头', async () => {
    const spy = stubFetch();
    await radarActionApi.revert({ candidateId: 'cand-1', family: 'save' });
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/actions/revert`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
    expect(JSON.parse(c.body as string)).toEqual({ candidateId: 'cand-1', family: 'save' });
  });

  it('非 2xx 传播为 ApiError，保留后端安全 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'RADAR_CANDIDATE_NOT_FOUND', message: '候选不存在' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(radarActionApi.getView('nope')).rejects.toMatchObject({
      status: 404, message: '候选不存在',
    } satisfies Partial<ApiError>);
  });
});
