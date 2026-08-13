/**
 * v0.9 Phase 4C-2 — OpenWebContentFetcher 测试。
 *
 * 全部使用注入 resolver / transport（node:http/https 的 seam）+ 确定性 stream，
 * 不发起任何真实网络。覆盖 Scope Lock v3 的运行时不变量：
 *   - forged request 无法绕过 Source Policy；policy blocked 时 DNS/transport 零调用。
 *   - private IP 无法连接；redirect 无法绕到 unknown / SEARCH_ONLY / private。
 *   - custom lookup 不重新 DNS；servername 保持原 hostname。
 *   - 30s 是总体 deadline（跨 redirect 不重置）；timeout 不二次映射 NETWORK_ERROR。
 *   - wire / decoded 双重有界；Content-Length 提前拒绝但 stream counter 仍权威。
 *   - gzip / deflate / br 解压；unsupported encoding 稳定失败。
 *   - unsupported charset / fatal decode 稳定失败。
 *   - FETCHED 分支不携带 evidenceLevel / success / rawHtml。
 */
import { describe, expect, it, vi } from 'vitest';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import {
  createOpenWebContentFetcher,
  decodeContentEncoding,
  readBounded,
  type TransportRequest,
  type TransportRequestOptions,
  type TransportResponse,
} from './OpenWebContentFetcher';
import type { DnsResolver, ResolvedAddress } from './ssrfGuard';
import { isEvidenceUpgradeEligible } from './types';
import type { ContentFetchRequest } from './types';

// ── helpers ────────────────────────────────────────────────────────────────────

const JD_HTML = [
  '<html><head><title>Senior Software Engineer</title></head><body>',
  '<h1>Senior Software Engineer</h1>',
  '<h2>Responsibilities</h2><p>Design and implement scalable backend systems, collaborate with cross-functional teams, and mentor junior engineers.</p>',
  '<h2>Requirements</h2><p>5+ years of experience building distributed systems, strong problem-solving skills.</p>',
  '<p>Salary: competitive.</p>',
  '</body></html>',
].join('');

function req(url = 'https://jobs.zhiye.com/jobs/1'): ContentFetchRequest {
  return { url, normalizedDomain: 'jobs.zhiye.com', sourcePolicy: 'SEARCH_AND_FETCH' };
}

async function* chunks(...items: Buffer[]): AsyncIterable<Buffer> {
  for (const b of items) yield b;
}

function htmlResponse(
  body = JD_HTML,
  headers: Record<string, string> = {},
  statusCode = 200,
): TransportResponse {
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: chunks(Buffer.from(body, 'utf8')),
    cancel: vi.fn(),
  };
}

function makeTransport(
  impl: (opts: TransportRequestOptions) => Promise<TransportResponse>,
): TransportRequest {
  return vi.fn(impl) as unknown as TransportRequest;
}

function publicResolver(): DnsResolver {
  return {
    lookup: vi.fn(async (_h: string, _s: AbortSignal): Promise<ResolvedAddress[]> => [
      { address: '1.1.1.1', family: 4 },
    ]),
  };
}

function privateResolver(): DnsResolver {
  return {
    lookup: vi.fn(async (_h: string, _s: AbortSignal): Promise<ResolvedAddress[]> => [
      { address: '10.0.0.1', family: 4 },
    ]),
  };
}

// ── Runtime Source Policy revalidation ─────────────────────────────────────────

describe('runtime Source Policy revalidation', () => {
  it('forged request（url=zhipin.com）→ BLOCKED_BY_POLICY，DNS/transport 零调用', async () => {
    const resolver = publicResolver();
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver, transport });
    const r = await fetcher.fetch({
      url: 'https://www.zhipin.com/job_detail/1.html',
      normalizedDomain: 'jobs.zhiye.com',
      sourcePolicy: 'SEARCH_AND_FETCH',
    });
    expect(r.status).toBe('BLOCKED_BY_POLICY');
    expect(transport).not.toHaveBeenCalled();
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it('unknown domain → BLOCKED_BY_POLICY', async () => {
    const resolver = publicResolver();
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver, transport });
    const r = await fetcher.fetch(req('https://unknown-company.xyz/jobs/1'));
    expect(r.status).toBe('BLOCKED_BY_POLICY');
    expect(transport).not.toHaveBeenCalled();
  });
});

// ── SSRF / DNS ─────────────────────────────────────────────────────────────────

describe('SSRF / DNS', () => {
  it('allowlisted hostname 解析到 private IP → SSRF_BLOCKED，transport 零调用', async () => {
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver: privateResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('SSRF_BLOCKED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('DNS 无地址（ENOTFOUND）→ NETWORK_ERROR（非 SSRF_BLOCKED）', async () => {
    const resolver: DnsResolver = {
      lookup: vi.fn(async () => {
        throw new Error('ENOTFOUND');
      }),
    };
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver, transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('NETWORK_ERROR');
    expect(transport).not.toHaveBeenCalled();
  });

  it('transport 收到 pinned lookup + 原 hostname servername', async () => {
    const resolver = publicResolver();
    let captured: TransportRequestOptions | undefined;
    const transport = makeTransport(async (opts) => {
      captured = opts;
      return htmlResponse();
    });
    const fetcher = createOpenWebContentFetcher({ resolver, transport });
    const r = await fetcher.fetch(req('https://jobs.zhiye.com/jobs/1'));
    expect(r.status).toBe('FETCHED');
    expect(captured).toBeDefined();
    expect(captured!.servername).toBe('jobs.zhiye.com');
    // lookup 只返回已校验地址，不重新 DNS
    const callback = vi.fn();
    captured!.lookup('jobs.zhiye.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    // 系统 resolver 仅在 validateHostname 调用一次，pinned lookup 不再次调用系统 resolver
    expect(resolver.lookup).toHaveBeenCalledTimes(1);
  });
});

// ── Redirect ───────────────────────────────────────────────────────────────────

describe('redirect', () => {
  it('redirect 到 unknown domain → BLOCKED_BY_POLICY', async () => {
    const transport = makeTransport(async (opts) => {
      if (opts.url.hostname === 'jobs.zhiye.com') {
        return { statusCode: 302, headers: { location: 'https://unknown-company.xyz/jobs/1' }, body: chunks(), cancel: vi.fn() };
      }
      return htmlResponse();
    });
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('BLOCKED_BY_POLICY');
  });

  it('redirect 到 allowlisted 但解析 private → SSRF_BLOCKED', async () => {
    const transport = makeTransport(async (opts) => {
      if (opts.url.hostname === 'jobs.zhiye.com') {
        return { statusCode: 302, headers: { location: 'https://github.com/jobs/1' }, body: chunks(), cancel: vi.fn() };
      }
      return htmlResponse();
    });
    const resolver: DnsResolver = {
      lookup: vi.fn(async (host: string): Promise<ResolvedAddress[]> =>
        host === 'github.com'
          ? [{ address: '10.0.0.1', family: 4 }]
          : [{ address: '1.1.1.1', family: 4 }],
      ),
    };
    const fetcher = createOpenWebContentFetcher({ resolver, transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('SSRF_BLOCKED');
  });

  it('HTTPS → HTTP downgrade → REDIRECT_BLOCKED', async () => {
    const transport = makeTransport(async () => ({
      statusCode: 302,
      headers: { location: 'http://jobs.zhiye.com/jobs/1' },
      body: chunks(),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('REDIRECT_BLOCKED');
    if (r.status === 'REDIRECT_BLOCKED') {
      expect(r.error.reasonCode).toBe('https_downgrade_blocked');
    }
  });

  it('3xx 无 Location → REDIRECT_BLOCKED', async () => {
    const transport = makeTransport(async () => ({ statusCode: 302, headers: {}, body: chunks(), cancel: vi.fn() }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('REDIRECT_BLOCKED');
  });

  it('redirect 跟随成功（相对 Location）', async () => {
    const transport = makeTransport(async (opts) => {
      if (opts.url.pathname === '/first') {
        return { statusCode: 301, headers: { location: '/final' }, body: chunks(), cancel: vi.fn() };
      }
      return htmlResponse();
    });
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req('https://jobs.zhiye.com/first'));
    expect(r.status).toBe('FETCHED');
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

// ── HTTP error semantics ───────────────────────────────────────────────────────

describe('HTTP error semantics', () => {
  const cases: Array<[number, string]> = [
    [401, 'ACCESS_DENIED'],
    [403, 'ACCESS_DENIED'],
    [407, 'ACCESS_DENIED'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [500, 'NETWORK_ERROR'],
  ];
  for (const [code, status] of cases) {
    it(`HTTP ${code} → ${status}`, async () => {
      const transport = makeTransport(async () => htmlResponse(JD_HTML, {}, code));
      const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
      const r = await fetcher.fetch(req());
      expect(r.status).toBe(status);
    });
  }

  it('unsupported content-type → UNSUPPORTED_CONTENT', async () => {
    const transport = makeTransport(async () => htmlResponse(JD_HTML, { 'content-type': 'application/pdf' }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('UNSUPPORTED_CONTENT');
  });
});

// ── Content-Encoding ───────────────────────────────────────────────────────────

describe('content-encoding', () => {
  it('gzip 正常解压', async () => {
    const gzipped = gzipSync(Buffer.from(JD_HTML, 'utf8'));
    const transport = makeTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
      body: chunks(gzipped),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('FETCHED');
  });

  it('unsupported content-encoding → UNSUPPORTED_CONTENT', async () => {
    const transport = makeTransport(async () => htmlResponse(JD_HTML, { 'content-encoding': 'zstd' }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('UNSUPPORTED_CONTENT');
    if (r.status === 'UNSUPPORTED_CONTENT') {
      expect(r.error.reasonCode).toBe('unsupported_content_encoding');
    }
  });
});

describe('decodeContentEncoding (direct)', () => {
  it('gzip / deflate / br 正常解压', async () => {
    const payload = Buffer.from(JD_HTML, 'utf8');
    const gz = await decodeContentEncoding(gzipSync(payload), 'gzip', 100000);
    const df = await decodeContentEncoding(deflateSync(payload), 'deflate', 100000);
    const br = await decodeContentEncoding(brotliCompressSync(payload), 'br', 100000);
    expect(gz.kind).toBe('ok');
    expect(df.kind).toBe('ok');
    expect(br.kind).toBe('ok');
  });

  it('unknown → unsupported', async () => {
    const r = await decodeContentEncoding(Buffer.from('x'), 'zstd', 1000);
    expect(r).toEqual({ kind: 'unsupported', encoding: 'zstd' });
  });

  it('identity / 无 header → ok 原样', async () => {
    const r = await decodeContentEncoding(Buffer.from('x'), undefined, 1000);
    expect(r).toEqual({ kind: 'ok', data: Buffer.from('x') });
  });
});

// ── Charset / decode ───────────────────────────────────────────────────────────

describe('charset / decode', () => {
  it('unsupported charset → UNSUPPORTED_CHARSET', async () => {
    const transport = makeTransport(async () => htmlResponse(JD_HTML, { 'content-type': 'text/html; charset=bogus' }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('UNSUPPORTED_CHARSET');
  });

  it('fatal decode failure → DECODE_FAILED', async () => {
    const transport = makeTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: chunks(Buffer.from([0x48, 0x69, 0xff])),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('DECODE_FAILED');
  });
});

// ── Response bound ─────────────────────────────────────────────────────────────

describe('response bound', () => {
  it('wire bytes 超限 → RESPONSE_TOO_LARGE (wire)', async () => {
    const big = Buffer.alloc(1024, 0x61);
    const transport = makeTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
      body: chunks(big),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport, maxWireBytes: 100 });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('RESPONSE_TOO_LARGE');
    if (r.status === 'RESPONSE_TOO_LARGE') {
      expect(r.error.reasonCode).toBe('wire_response_too_large');
    }
  });

  it('Content-Length 提前拒绝', async () => {
    const transport = makeTransport(async () => htmlResponse(JD_HTML, { 'content-length': '999999' }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport, maxWireBytes: 100 });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('RESPONSE_TOO_LARGE');
  });

  it('Content-Length 小于真实 body → stream counter 捕获', async () => {
    const big = Buffer.alloc(1024, 0x61);
    const transport = makeTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html', 'content-length': '10' },
      body: chunks(big),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport, maxWireBytes: 100 });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('RESPONSE_TOO_LARGE');
  });

  it('decoded bytes 超限 → RESPONSE_TOO_LARGE (decoded)', async () => {
    const bigHtml = '<html><body>' + 'a'.repeat(2000) + '</body></html>';
    const gzipped = gzipSync(Buffer.from(bigHtml, 'utf8'));
    const transport = makeTransport(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      body: chunks(gzipped),
      cancel: vi.fn(),
    }));
    const fetcher = createOpenWebContentFetcher({
      resolver: publicResolver(),
      transport,
      maxWireBytes: 100000,
      maxDecodedBytes: 100,
    });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('RESPONSE_TOO_LARGE');
    if (r.status === 'RESPONSE_TOO_LARGE') {
      expect(r.error.reasonCode).toBe('decoded_response_too_large');
    }
  });
});

describe('readBounded (direct)', () => {
  it('超限 → too_large', async () => {
    const r = await readBounded(chunks(Buffer.alloc(10), Buffer.alloc(10)), 15, new AbortController().signal);
    expect(r.kind).toBe('too_large');
  });

  it('signal aborted → aborted', async () => {
    const c = new AbortController();
    c.abort();
    const r = await readBounded(chunks(Buffer.from('x')), 100, c.signal);
    expect(r.kind).toBe('aborted');
  });
});

// ── Timeout / deadline ─────────────────────────────────────────────────────────

describe('timeout / deadline', () => {
  it('overall deadline → TIMEOUT（不二次映射 NETWORK_ERROR）', async () => {
    const transport = makeTransport(async (opts) => new Promise<TransportResponse>((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport, timeoutMs: 5 });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('TIMEOUT');
  });

  it('deadline 跨 redirect 不重置（单次总体 deadline）', async () => {
    const transport = makeTransport(async (opts) => {
      if (opts.url.pathname === '/first') {
        return { statusCode: 302, headers: { location: '/second' }, body: chunks(), cancel: vi.fn() };
      }
      return new Promise<TransportResponse>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport, timeoutMs: 10 });
    const r = await fetcher.fetch(req('https://jobs.zhiye.com/first'));
    expect(r.status).toBe('TIMEOUT');
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('deadline 后 lookup 晚返回 → 丢弃结果，不继续 HTTP transport', async () => {
    // resolver 晚返回（deadline 已触发），validateHostname 检测 signal.aborted 后抛错
    const resolver: DnsResolver = {
      lookup: vi.fn(async (_h: string, _s: AbortSignal): Promise<ResolvedAddress[]> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return [{ address: '1.1.1.1', family: 4 }];
      }),
    };
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver, transport, timeoutMs: 5 });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('TIMEOUT');
    expect(transport).not.toHaveBeenCalled();
  });
});

// ── FETCHED + 不变量 ───────────────────────────────────────────────────────────

describe('FETCHED + 不变量', () => {
  it('完整 JD → FETCHED + PASS；不携带 evidenceLevel / success / rawHtml', async () => {
    const transport = makeTransport(async () => htmlResponse());
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('FETCHED');
    if (r.status === 'FETCHED') {
      expect(r.validation.status).toBe('PASS');
      expect(isEvidenceUpgradeEligible(r.validation)).toBe(true);
      // FETCHED 分支只有 content + validation，无 evidenceLevel / success
      expect(Object.keys(r)).toEqual(['status', 'content', 'validation']);
      // ExtractedContent 无 rawHtml / raw_content
      expect(Object.keys(r.content)).toEqual(['title', 'plainText', 'canonicalUrl', 'contentType']);
      expect(r.content.plainText).toContain('Responsibilities');
    }
  });

  it('HTTP 200 login wall 页 → FETCHED + validation FAIL（非 transport ACCESS_DENIED）', async () => {
    const loginHtml = '<html><head><title>Sign In</title></head><body>Please sign in to continue</body></html>';
    const transport = makeTransport(async () => htmlResponse(loginHtml));
    const fetcher = createOpenWebContentFetcher({ resolver: publicResolver(), transport });
    const r = await fetcher.fetch(req());
    expect(r.status).toBe('FETCHED');
    if (r.status === 'FETCHED') {
      expect(r.validation.status).toBe('FAIL');
      expect(r.validation.reasonCode).toBe('login_wall');
    }
  });
});
