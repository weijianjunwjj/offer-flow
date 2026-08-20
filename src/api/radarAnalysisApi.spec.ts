import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, API_BASE } from './client';
import { radarAnalysisApi } from './radarAnalysisApi';

const CAPTURE_HEADER = 'x-offerflow-capture-client';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function stubFetch(body: unknown = { ok: true }) {
  const spy = vi.fn().mockResolvedValue(okJson(body));
  vi.stubGlobal('fetch', spy);
  return spy;
}
/** 从 fetch 调用还原 (url, method, headers)。 */
function call(spy: ReturnType<typeof vi.fn>) {
  const [url, init] = spy.mock.calls[0] as [string, RequestInit | undefined];
  return { url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string> };
}

describe('radarAnalysisApi 七接口 method/path/headers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('createTask → POST candidate-versions/:id/analysis-tasks', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.createTask('cv-1');
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/candidate-versions/cv-1/analysis-tasks`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
  });

  it('getTask → GET analysis-tasks/:id', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.getTask('task-1');
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/analysis-tasks/task-1`);
    expect(c.headers[CAPTURE_HEADER]).toBe('offerflow-web');
  });

  it('runTask → POST analysis-tasks/:id/run', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.runTask('task-1');
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/analysis-tasks/task-1/run`);
  });

  it('retryTask → POST analysis-tasks/:id/retry', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.retryTask('task-1');
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/analysis-tasks/task-1/retry`);
  });

  it('cancelTask → POST analysis-tasks/:id/cancel', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.cancelTask('task-1');
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/radar/analysis-tasks/task-1/cancel`);
  });

  it('listCandidateAnalyses → GET candidates/:id/analyses', async () => {
    const spy = stubFetch([]);
    await radarAnalysisApi.listCandidateAnalyses('cand-1');
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/candidates/cand-1/analyses`);
  });

  it('getAnalysis → GET analyses/:id', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.getAnalysis('rec-1');
    const c = call(spy);
    expect(c.method).toBe('GET');
    expect(c.url).toBe(`${API_BASE}/radar/analyses/rec-1`);
  });
});

describe('radarAnalysisApi 编码 / 错误传播 / 不自带敏感字段', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('对路径参数做 URL 编码', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.getAnalysis('rec/../x');
    expect(call(spy).url).toBe(`${API_BASE}/radar/analyses/rec%2F..%2Fx`);
  });

  it('非 2xx 传播为 ApiError，保留后端安全 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'INPUT_NOT_READY', message: '缺少 active 简历' }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(radarAnalysisApi.createTask('cv-1')).rejects.toMatchObject({
      status: 422, message: '缺少 active 简历',
    } satisfies Partial<ApiError>);
  });

  it('409 冲突同样传播 ApiError（供面板刷新逻辑区分）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'ATTEMPTS_EXHAUSTED', message: '已达重试上限' }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(radarAnalysisApi.retryTask('task-1')).rejects.toMatchObject({ status: 409 });
  });

  it('POST 无 body 时不携带 Content-Type（不自造请求体字段）', async () => {
    const spy = stubFetch();
    await radarAnalysisApi.runTask('task-1');
    const c = call(spy);
    expect(c.headers['Content-Type']).toBeUndefined();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });
});
