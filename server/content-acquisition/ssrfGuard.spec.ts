/**
 * v0.9 Phase 4C-2 — ssrfGuard 测试（Resolver Compatibility Amendment：system lookup seam）。
 *
 * 覆盖 Scope Lock v3 + Resolver Amendment：
 *   - classifyIp：loopback / RFC1918 / link-local / CGNAT / multicast / unspecified /
 *     documentation / IPv4-mapped IPv6 / 6to4 / Teredo。
 *   - validateHostname：IP literal 不走 DNS；lookup 单 IPv4/IPv6/多 public → allowed；
 *     public+private / loopback → ssrf_blocked；空数组 / ENOTFOUND / 其他失败 → dns_failure。
 *   - makePinnedLookup：只返回已校验地址、不重新 DNS。
 *   - parseAndValidateUrl：protocol / credentials。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyIp,
  isIpLiteral,
  makePinnedLookup,
  parseAndValidateUrl,
  validateHostname,
  type DnsResolver,
  type ResolvedAddress,
} from './ssrfGuard';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeResolver(lookup?: ResolvedAddress[] | Error): DnsResolver {
  return {
    lookup: vi.fn(async (_h: string, _s: AbortSignal): Promise<ResolvedAddress[]> => {
      if (lookup instanceof Error) throw lookup;
      return lookup ?? [];
    }),
  };
}

// ── classifyIp ─────────────────────────────────────────────────────────────────

describe('classifyIp — non-public', () => {
  const nonPublic = [
    '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.0.1', '100.64.0.1', '224.0.0.1', '0.0.0.0', '255.255.255.255',
    '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '240.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fdff::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:0808:0808::1', '2001:0000::1',
  ];
  for (const ip of nonPublic) {
    it(`${ip} → non-public`, () => {
      expect(classifyIp(ip)).toBe('non-public');
    });
  }
});

describe('classifyIp — public', () => {
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '::ffff:8.8.8.8', '2606:4700:4700::1111'];
  for (const ip of pub) {
    it(`${ip} → public`, () => {
      expect(classifyIp(ip)).toBe('public');
    });
  }
});

describe('isIpLiteral', () => {
  it('IPv4 / IPv6 literal → true；hostname → false', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('::1')).toBe(true);
    expect(isIpLiteral('jobs.zhiye.com')).toBe(false);
  });
});

// ── validateHostname ───────────────────────────────────────────────────────────

describe('validateHostname — IP literal 不走 DNS', () => {
  it('non-public literal → ssrf_blocked，且 resolver.lookup 零调用', async () => {
    const resolver = makeResolver();
    const signal = new AbortController().signal;
    const r = await validateHostname('127.0.0.1', resolver, signal);
    expect(r.kind).toBe('ssrf_blocked');
    expect(resolver.lookup).not.toHaveBeenCalled();
  });

  it('public literal → allowed（单地址），且 resolver.lookup 零调用', async () => {
    const resolver = makeResolver();
    const signal = new AbortController().signal;
    const r = await validateHostname('8.8.8.8', resolver, signal);
    expect(r.kind).toBe('allowed');
    if (r.kind === 'allowed') {
      expect(r.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    }
    expect(resolver.lookup).not.toHaveBeenCalled();
  });
});

describe('validateHostname — system lookup', () => {
  it('单 IPv4 public → allowed', async () => {
    const resolver = makeResolver([{ address: '1.1.1.1', family: 4 }]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('allowed');
  });

  it('单 IPv6 public → allowed', async () => {
    const resolver = makeResolver([{ address: '2606:4700:4700::1111', family: 6 }]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('allowed');
  });

  it('多个 public → allowed', async () => {
    const resolver = makeResolver([
      { address: '1.1.1.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('allowed');
    if (r.kind === 'allowed') expect(r.addresses).toHaveLength(2);
  });

  it('public + private 混合 → ssrf_blocked', async () => {
    const resolver = makeResolver([
      { address: '1.1.1.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('ssrf_blocked');
  });

  it('loopback → ssrf_blocked', async () => {
    const resolver = makeResolver([{ address: '127.0.0.1', family: 4 }]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('ssrf_blocked');
  });

  it('空数组 → dns_failure', async () => {
    const resolver = makeResolver([]);
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('dns_failure');
  });

  it('ENOTFOUND → dns_failure（非 ssrf_blocked）', async () => {
    const resolver = makeResolver(new Error('ENOTFOUND'));
    const r = await validateHostname('nonexistent.example', resolver, new AbortController().signal);
    expect(r.kind).toBe('dns_failure');
  });

  it('其他 resolver failure（EAI_AGAIN）→ dns_failure', async () => {
    const resolver = makeResolver(new Error('EAI_AGAIN'));
    const r = await validateHostname('example.com', resolver, new AbortController().signal);
    expect(r.kind).toBe('dns_failure');
  });
});

// ── makePinnedLookup ───────────────────────────────────────────────────────────

describe('makePinnedLookup', () => {
  it('只返回已校验地址，不重新 DNS（单地址 form）', () => {
    const lookup = makePinnedLookup([{ address: '1.1.1.1', family: 4 }]);
    const callback = vi.fn();
    lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
  });

  it('all:true 返回地址数组（Node http autoSelectFamily 契约）', () => {
    const lookup = makePinnedLookup([{ address: '1.1.1.1', family: 4 }]);
    const callback = vi.fn();
    lookup('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
  });

  it('无地址 → callback 报错', () => {
    const lookup = makePinnedLookup([]);
    const callback = vi.fn();
    lookup('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalled();
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// ── parseAndValidateUrl ────────────────────────────────────────────────────────

describe('parseAndValidateUrl', () => {
  it('合法 https URL → ok', () => {
    const r = parseAndValidateUrl('https://jobs.zhiye.com/jobs/1');
    expect(r.kind).toBe('ok');
  });

  it('非 http(s) 协议 → unsafe', () => {
    const r = parseAndValidateUrl('ftp://example.com/x');
    expect(r).toEqual({ kind: 'unsafe', reasonCode: 'unsupported_protocol' });
  });

  it('带 credentials → unsafe', () => {
    const r = parseAndValidateUrl('https://user:pass@jobs.zhiye.com/x');
    expect(r).toEqual({ kind: 'unsafe', reasonCode: 'credentials_in_url' });
  });

  it('非法 URL → invalid', () => {
    const r = parseAndValidateUrl('not a url');
    expect(r).toEqual({ kind: 'invalid', reasonCode: 'invalid_url' });
  });
});
