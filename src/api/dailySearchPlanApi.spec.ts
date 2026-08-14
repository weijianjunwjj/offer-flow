import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { dailySearchPlanApi } from './dailySearchPlanApi';

const API_BASE = 'http://127.0.0.1:17365';

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function stubFetch(body: unknown = {}) {
  // 每次调用返回新的 Response（body 只能被消费一次），支持同一测试内多次请求。
  const spy = vi.fn().mockImplementation(() => Promise.resolve(okJson(body)));
  vi.stubGlobal('fetch', spy);
  return spy;
}
function call(spy: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = spy.mock.calls[index] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method ?? 'GET',
    body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

const config = {
  cities: [{ name: '苏州', priority: 1 }],
  roleDirections: ['前端开发'],
  baseKeywords: ['React'],
  expandedKeywords: [],
  hardConstraints: [],
  sourceConfigs: [{ providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true }],
  schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
  scanBudget: {},
  analysisBudget: {},
  briefPolicy: {},
  explorationPolicy: {},
  notificationPolicy: {},
  latestCatchUpTime: '12:00',
};

describe('dailySearchPlanApi method/path/body', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('list → GET /daily-search-plans', async () => {
    const spy = stubFetch({ plans: [] });
    await dailySearchPlanApi.list();
    expect(call(spy)).toEqual({ url: `${API_BASE}/daily-search-plans`, method: 'GET', body: undefined });
  });

  it('get → GET /daily-search-plans/:id（路径编码）', async () => {
    const spy = stubFetch({ plan: {}, activeVersion: null });
    await dailySearchPlanApi.get('p/1');
    expect(call(spy).url).toBe(`${API_BASE}/daily-search-plans/p%2F1`);
  });

  it('listVersions → GET /daily-search-plans/:id/versions', async () => {
    const spy = stubFetch({ versions: [] });
    await dailySearchPlanApi.listVersions('p1');
    expect(call(spy).url).toBe(`${API_BASE}/daily-search-plans/p1/versions`);
  });

  it('create → POST /daily-search-plans，携带 name + config', async () => {
    const spy = stubFetch({ plan: {}, version: {} });
    await dailySearchPlanApi.create({ name: '每日前端岗位', ...config });
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/daily-search-plans`);
    expect(c.body).toEqual({ name: '每日前端岗位', ...config });
  });

  it('createVersion → POST /daily-search-plans/:id/versions，仅 config（无 name）', async () => {
    const spy = stubFetch({ version: {} });
    await dailySearchPlanApi.createVersion('p1', config);
    const c = call(spy);
    expect(c.method).toBe('POST');
    expect(c.url).toBe(`${API_BASE}/daily-search-plans/p1/versions`);
    expect(c.body).toEqual(config);
    expect(c.body).not.toHaveProperty('name');
  });

  it('pause / resume / skip-today / run-now → 对应 POST 端点', async () => {
    const spy = stubFetch({});
    await dailySearchPlanApi.pause('p1');
    expect(call(spy, 0)).toEqual({ url: `${API_BASE}/daily-search-plans/p1/pause`, method: 'POST', body: undefined });

    await dailySearchPlanApi.resume('p1');
    expect(call(spy, 1).url).toBe(`${API_BASE}/daily-search-plans/p1/resume`);

    await dailySearchPlanApi.skipToday('p1');
    expect(call(spy, 2).url).toBe(`${API_BASE}/daily-search-plans/p1/skip-today`);

    await dailySearchPlanApi.runNow('p1');
    expect(call(spy, 3).url).toBe(`${API_BASE}/daily-search-plans/p1/run-now`);
  });

  it('非 2xx 传播为 ApiError，保留后端 code/message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'RUN_IN_PROGRESS', message: '该计划已有进行中的运行' }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    ));
    await expect(dailySearchPlanApi.runNow('p1')).rejects.toMatchObject({
      status: 409, message: '该计划已有进行中的运行',
    } satisfies Partial<ApiError>);
  });
});
