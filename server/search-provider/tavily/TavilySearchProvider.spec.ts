/**
 * OfferFlow v0.9 — Tavily Search Provider tests.
 *
 * Task: T026
 *
 * Covers:
 *  - Successful search → SearchEvidenceItem[] mapped correctly
 *  - VALID_EMPTY (HTTP 200 + results=[])
 *  - AUTH_ERROR (HTTP 401)
 *  - RATE_LIMITED (HTTP 429)
 *  - USAGE_LIMIT (HTTP 432)
 *  - TIMEOUT
 *  - NETWORK_ERROR
 *  - MALFORMED_RESPONSE (bad JSON / wrong shape)
 *  - PROVIDER_UNAVAILABLE (5xx)
 *  - AbortSignal cancellation
 *  - Rate limiter (Token Bucket) behavior
 *  - Field mapping: content, score, url, domain
 */

import { describe, it, expect, vi } from 'vitest';
import { TavilySearchProvider } from './TavilySearchProvider';
import type { SearchProviderRequest } from '../SearchProviderAdapter';
import type { SearchQuery } from '../types';
import { TokenBucketRateLimiter } from './tavilyRateLimiter';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeQuery(overrides?: Partial<SearchQuery>): SearchQuery {
  return {
    query: '苏州 前端工程师 招聘',
    queryKey: '苏州×前端开发×React',
    city: '苏州',
    roleDirection: '前端开发',
    keyword: 'React',
    keywordSource: 'base',
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<SearchProviderRequest>): SearchProviderRequest {
  return {
    queries: [makeQuery()],
    config: { maxResults: 5 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

const TAVILY_OK_RESPONSE = {
  query: '苏州 前端工程师 招聘',
  results: [
    {
      title: '高级前端开发工程师',
      url: 'https://www.zhipin.com/job_detail/xxx.html',
      content: '负责Web前端开发，使用React、TypeScript，5年以上经验',
      score: 0.85,
      raw_content: null,
      published_date: '2026-08-10',
    },
    {
      title: '前端技术负责人',
      url: 'https://www.lagou.com/jobs/yyy.html',
      content: '带领前端团队，React/Next.js技术栈',
      score: 0.72,
      raw_content: null,
    },
  ],
  response_time: 0.45,
  images: [],
  usage: {
    credit_used: 1,
  },
};

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

function mockNetworkError(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message)) as unknown as typeof fetch;
}

/** 构造 undici 风格的瞬时传输错误（cause.code 承载 taxonomy，与真实 fetch failed 一致）。 */
function transientTransportError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

/** retry 测试注入 seam：禁用真实等待与抖动，避免测试真实 sleep。 */
const retrySeams = {
  sleep: async (): Promise<void> => {},
  backoffDelayMs: (): number => 0,
};

const MOCK_API_KEY = 'tvly-test-key-123';

// ── Success ──────────────────────────────────────────────────────────────────

describe('TavilySearchProvider — success', () => {
  it('maps Tavily results to SearchEvidenceItem[]', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.items).toHaveLength(2);

    const first = result.items[0];
    expect(first.provider).toBe('tavily');
    expect(first.title).toBe('高级前端开发工程师');
    expect(first.url).toBe('https://www.zhipin.com/job_detail/xxx.html');
    expect(first.content).toBe('负责Web前端开发，使用React、TypeScript，5年以上经验');
    expect(first.domain).toBe('www.zhipin.com');
    expect(first.providerScore).toBe(0.85);
    expect(first.publishedAt).toBe('2026-08-10');
    expect(first.evidenceLevel).toBe('SEARCH_EVIDENCE');
    expect(typeof first.searchedAt).toBe('number');
  });

  it('reports coverage correctly', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.queriesCompleted).toBe(1);
    expect(result.coverage.queriesFailed).toBe(0);
    expect(result.coverage.failedScopes).toHaveLength(0);
    expect(result.coverage.queryResults).toHaveLength(1);
    expect(result.coverage.queryResults[0].status).toBe('COMPLETED');
    expect(result.coverage.queryResults[0].resultsReturned).toBe(2);
  });

  it('reports provider meta with credits', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.providerMeta.requestsMade).toBe(1);
    expect(result.providerMeta.creditsUsed).toBe(1);
  });

  it('uses Bearer token authorization', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    await provider.search(makeRequest());

    const call = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].headers.Authorization).toBe('Bearer tvly-test-key-123');
  });

  it('resolves api key on each request', async () => {
    let callCount = 0;
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => {
        callCount++;
        return `tvly-key-${callCount}`;
      },
      fetchImpl: fakeFetch,
    });

    await provider.search(makeRequest());

    expect(callCount).toBe(1);
  });

  it('sends correct Tavily request body', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    await provider.search(makeRequest());

    const call = (fakeFetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.query).toBe('苏州 前端工程师 招聘');
    expect(body.search_depth).toBe('basic');
    expect(body.country).toBe('china');
    expect(body.topic).toBe('general');
    expect(body.include_answer).toBe(false);
    expect(body.include_raw_content).toBe(false);
    expect(body.include_usage).toBe(true);
    expect(body.max_results).toBe(5);
    // auto_parameters MUST NOT be present
    expect(body.auto_parameters).toBeUndefined();
  });
});

// ── VALID_EMPTY ──────────────────────────────────────────────────────────────

describe('TavilySearchProvider — VALID_EMPTY', () => {
  it('handles valid response with empty results', async () => {
    const fakeFetch = mockFetch(200, {
      query: '查询 无结果',
      results: [],
      response_time: 0.2,
    });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest({
      queries: [makeQuery({ query: '查询 无结果', queryKey: 'empty' })],
    }));

    expect(result.items).toHaveLength(0);
    expect(result.coverage.queriesCompleted).toBe(1);
    expect(result.coverage.queriesFailed).toBe(0);
    expect(result.coverage.queryResults[0].status).toBe('VALID_EMPTY');
    expect(result.coverage.queryResults[0].errorCode).toBe('VALID_EMPTY');
  });
});

// ── AUTH_ERROR ───────────────────────────────────────────────────────────────

describe('TavilySearchProvider — AUTH_ERROR', () => {
  it('returns AUTH_ERROR on HTTP 401', async () => {
    const fakeFetch = mockFetch(401, { error: 'Unauthorized' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.items).toHaveLength(0);
    expect(result.coverage.queriesFailed).toBe(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('AUTH_ERROR');
  });
});

// ── RATE_LIMITED ─────────────────────────────────────────────────────────────

describe('TavilySearchProvider — RATE_LIMITED', () => {
  it('returns RATE_LIMITED on HTTP 429', async () => {
    const fakeFetch = mockFetch(429, { error: 'Too Many Requests' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('RATE_LIMITED');
  });

  it('local rate limiter blocks requests when bucket is empty', async () => {
    // Bucket with 0 tokens — nothing passes
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 0,
      refillRate: 0.01,
      refillInterval: 1000,
    });
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      rateLimiter: limiter,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('RATE_LIMITED');
    // No HTTP call made
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});

// ── USAGE_LIMIT ──────────────────────────────────────────────────────────────

describe('TavilySearchProvider — USAGE_LIMIT', () => {
  it('returns USAGE_LIMIT on HTTP 432', async () => {
    const fakeFetch = mockFetch(432, { error: 'Usage Limit Exceeded' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('USAGE_LIMIT');
  });
});

// ── TIMEOUT ──────────────────────────────────────────────────────────────────

describe('TavilySearchProvider — TIMEOUT', () => {
  it('returns TIMEOUT when request exceeds timeout', async () => {
    // Use AbortSignal.timeout to force abort after 50ms.
    // The fetch mock hangs forever; the provider's internal timeout fires.
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: vi.fn().mockImplementation(() => {
        return new Promise<Response>((_resolve, reject) => {
          const err = new DOMException('The operation was aborted', 'AbortError');
          setTimeout(() => reject(err), 40);
        });
      }) as unknown as typeof fetch,
      timeout: 1,
    });

    const result = await provider.search(makeRequest());

    // The mock reject with AbortError on next tick → provider catches as TIMEOUT
    expect(result.coverage.failedScopes[0].errorCode).toBe('TIMEOUT');
  });
});

// ── NETWORK_ERROR ────────────────────────────────────────────────────────────

describe('TavilySearchProvider — NETWORK_ERROR', () => {
  it('returns NETWORK_ERROR on network failure', async () => {
    const fakeFetch = mockNetworkError('connect ECONNREFUSED');
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('NETWORK_ERROR');
    expect(result.coverage.failedScopes[0].message).toContain('connect ECONNREFUSED');
  });
});

// ── MALFORMED_RESPONSE ───────────────────────────────────────────────────────

describe('TavilySearchProvider — MALFORMED_RESPONSE', () => {
  it('returns MALFORMED_RESPONSE on invalid JSON', async () => {
    const fakeFetch = {
      status: 200,
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    };
    const fetchImpl = vi.fn().mockResolvedValue(fakeFetch) as unknown as typeof fetch;
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('MALFORMED_RESPONSE');
  });

  it('returns MALFORMED_RESPONSE when response lacks query/results', async () => {
    const fakeFetch = mockFetch(200, { foo: 'bar' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('MALFORMED_RESPONSE');
  });

  it('returns MALFORMED_RESPONSE when results is not an array', async () => {
    const fakeFetch = mockFetch(200, { query: 'q', results: 'not-array' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('MALFORMED_RESPONSE');
  });
});

// ── PROVIDER_UNAVAILABLE ─────────────────────────────────────────────────────

describe('TavilySearchProvider — PROVIDER_UNAVAILABLE', () => {
  it('returns PROVIDER_UNAVAILABLE on HTTP 500', async () => {
    const fakeFetch = mockFetch(500, { error: 'Internal Server Error' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('PROVIDER_UNAVAILABLE');
  });

  it('returns PROVIDER_UNAVAILABLE on HTTP 503', async () => {
    const fakeFetch = mockFetch(503, { error: 'Service Unavailable' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search(makeRequest());

    expect(result.coverage.failedScopes[0].errorCode).toBe('PROVIDER_UNAVAILABLE');
  });
});

// ── AbortSignal ──────────────────────────────────────────────────────────────

describe('TavilySearchProvider — AbortSignal', () => {
  it('stops processing when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: mockFetch(200, TAVILY_OK_RESPONSE),
    });

    const result = await provider.search({
      queries: [makeQuery()],
      config: {},
      signal: controller.signal,
    });

    expect(result.items).toHaveLength(0);
    expect(result.coverage.queriesCompleted).toBe(0);
    // No HTTP call should be made since signal is pre-aborted
  });
});

// ── Multiple queries ─────────────────────────────────────────────────────────

describe('TavilySearchProvider — multiple queries', () => {
  it('handles mixed success and failure across queries', async () => {
    let callCount = 0;
    const fakeFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ status: 200, ok: true, json: async () => TAVILY_OK_RESPONSE });
      if (callCount === 2) return Promise.resolve({ status: 401, ok: false, json: async () => ({ error: 'Unauthorized' }) });
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ query: 'query3', results: [] }) });
    }) as unknown as typeof fetch;

    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
    });

    const result = await provider.search({
      queries: [
        makeQuery({ queryKey: '苏州×前端' }),
        makeQuery({ queryKey: '无锡×全栈' }),
        makeQuery({ queryKey: '上海×AI' }),
      ],
      config: {},
      signal: new AbortController().signal,
    });

    expect(result.items).toHaveLength(2); // from query 1
    expect(result.coverage.queriesCompleted).toBe(2); // query 1 (OK) + query 3 (VALID_EMPTY)
    expect(result.coverage.queriesFailed).toBe(1); // query 2 (AUTH_ERROR)
    expect(result.coverage.queryResults).toHaveLength(3);
  });
});

// ── Transient transport retry ───────────────────────────────────────────────

describe('TavilySearchProvider — transient transport retry', () => {
  it('first attempt success → no retry', async () => {
    const fakeFetch = mockFetch(200, TAVILY_OK_RESPONSE);
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.providerMeta.retriesUsed).toBe(0);
    expect(result.coverage.queriesCompleted).toBe(1);
  });

  it('first attempt UND_ERR_CONNECT_TIMEOUT, second success → logical success, no failedScopes', async () => {
    const fakeFetch = vi.fn()
      .mockRejectedValueOnce(transientTransportError('UND_ERR_CONNECT_TIMEOUT'))
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => TAVILY_OK_RESPONSE }) as unknown as typeof fetch;
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.coverage.queriesCompleted).toBe(1);
    expect(result.coverage.queriesFailed).toBe(0);
    expect(result.coverage.failedScopes).toHaveLength(0);
    expect(result.items).toHaveLength(2);
    expect(result.providerMeta.retriesUsed).toBe(1);
  });

  it('first attempt NETWORK_ERROR, second NETWORK_ERROR → logical failed, exactly 1 failedScope', async () => {
    const fakeFetch = vi.fn()
      .mockRejectedValueOnce(transientTransportError('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(transientTransportError('ECONNRESET')) as unknown as typeof fetch;
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(result.coverage.queriesCompleted).toBe(0);
    expect(result.coverage.queriesFailed).toBe(1);
    expect(result.coverage.failedScopes).toHaveLength(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('NETWORK_ERROR');
    expect(result.providerMeta.retriesUsed).toBe(1);
  });

  it('AUTH_ERROR (401) → no retry, fetch called once', async () => {
    const fakeFetch = mockFetch(401, { error: 'Unauthorized' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('AUTH_ERROR');
    expect(result.providerMeta.retriesUsed).toBe(0);
  });

  it('invalid request (400) → no retry, fetch called once', async () => {
    const fakeFetch = mockFetch(400, { error: 'Bad Request' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('NETWORK_ERROR');
    expect(result.providerMeta.retriesUsed).toBe(0);
  });

  it('rate limit (429) → no retry, existing failure semantics preserved', async () => {
    const fakeFetch = mockFetch(429, { error: 'Too Many Requests' });
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(result.coverage.failedScopes[0].errorCode).toBe('RATE_LIMITED');
    expect(result.providerMeta.retriesUsed).toBe(0);
  });

  it('30 logical queries with partial retry → logical count stays 30', async () => {
    const ok = { status: 200, ok: true, json: async () => TAVILY_OK_RESPONSE };
    const fakeFetch = vi.fn()
      .mockRejectedValueOnce(transientTransportError('UND_ERR_CONNECT_TIMEOUT')) // q0 attempt1
      .mockResolvedValueOnce(ok)                                                 // q0 attempt2 → success
      .mockRejectedValueOnce(transientTransportError('UND_ERR_CONNECT_TIMEOUT')) // q1 attempt1
      .mockRejectedValueOnce(transientTransportError('ECONNRESET'))              // q1 attempt2 → failed
      .mockResolvedValue(ok) as unknown as typeof fetch;                         // q2..q29

    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      rateLimiter: new TokenBucketRateLimiter({ maxTokens: 100, refillRate: 1, refillInterval: 1000 }),
      ...retrySeams,
    });

    const queries = Array.from({ length: 30 }, (_, i) => makeQuery({ queryKey: `q${i}` }));
    const result = await provider.search({
      queries,
      config: {},
      signal: new AbortController().signal,
    });

    expect(result.coverage.queriesCompleted).toBe(29);
    expect(result.coverage.queriesFailed).toBe(1);
    expect(result.coverage.queriesCompleted + result.coverage.queriesFailed).toBe(30);
    expect(result.coverage.failedScopes).toHaveLength(1);
    expect(result.providerMeta.requestsMade).toBe(32);
    expect(result.providerMeta.retriesUsed).toBe(2);
  });

  it('does not persist secret / authorization / raw transport detail', async () => {
    const fakeFetch = vi.fn()
      .mockRejectedValueOnce(transientTransportError('UND_ERR_CONNECT_TIMEOUT'))
      .mockRejectedValueOnce(transientTransportError('ECONNRESET')) as unknown as typeof fetch;
    const provider = new TavilySearchProvider({
      apiKeyResolver: () => MOCK_API_KEY,
      fetchImpl: fakeFetch,
      ...retrySeams,
    });

    const result = await provider.search(makeRequest());

    const message = result.coverage.failedScopes[0].message;
    expect(message).not.toContain(MOCK_API_KEY);
    expect(message).not.toContain('Authorization');
    expect(message).not.toContain('Bearer');
    expect(message).not.toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(message).not.toContain('ECONNRESET');
    expect(result.coverage.failedScopes[0].errorCode).toBe('NETWORK_ERROR');
  });
});
