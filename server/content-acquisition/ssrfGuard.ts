/**
 * v0.9 Phase 4C-2 — SSRF / DNS 防护（纯函数 + 可注入 DNS seam）。
 *
 * 设计依据：Phase 4C-2 Implementation Scope Lock v3 + Resolver Compatibility Amendment。
 *
 * 职责边界：
 *   - classifyIp：public / non-public 判定（覆盖 loopback / RFC1918 / link-local /
 *     CGNAT / multicast / unspecified / documentation / IPv4-mapped IPv6）。
 *   - validateHostname：IP literal 直判（不走 DNS）或系统名称解析
 *     dns.lookup({ all:true, order:'verbatim' })，分类所有已解析地址；
 *     零地址 / resolver failure → dns_failure；任意 non-public → ssrf_blocked。
 *   - makePinnedLookup：生成「只返回已校验地址、绝不重新 DNS」的 lookup 回调，
 *     用于把连接钉在已校验 IP 上，关闭 DNS rebinding TOCTOU 窗口。
 *   - parseAndValidateUrl：protocol / credentials 校验（http/https、无 userinfo）。
 *
 * Resolver primitive（有意设计，非 fallback hack）：
 *   - 使用 dns.lookup()（系统 getaddrinfo），而非 dns.resolve4/resolve6 的直连 DNS 查询。
 *     理由：与 Node/系统实际网络解析行为一致；返回的候选地址仍全部经过 IP classification；
 *     transport 仍使用 pinned validated IP，因此不会因切换 resolver 而绕过 SSRF guard。
 *
 * 本模块不做 HTTP、不做 DB、不维护第二份招聘平台黑名单。
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

// ── Types ──────────────────────────────────────────────────────────────────────

export type IpFamily = 4 | 6;

export interface ResolvedAddress {
  address: string;
  family: IpFamily;
}

export type IpClassification = 'public' | 'non-public';

/**
 * DNS resolver seam（注入以便测试；真实实现为系统 getaddrinfo，见 createNodeDnsResolver）。
 * 实现方需在 signal abort 时 reject，避免在 deadline 后悬挂。
 */
export interface DnsResolver {
  lookup(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]>;
}

export type HostnameValidationResult =
  | { kind: 'allowed'; addresses: ResolvedAddress[] }
  | { kind: 'ssrf_blocked'; reasonCode: string }
  | { kind: 'dns_failure'; reasonCode: string };

export type UrlSafetyResult =
  | { kind: 'ok'; url: URL }
  | { kind: 'invalid'; reasonCode: string }
  | { kind: 'unsafe'; reasonCode: string };

export interface LookupAddressLike {
  address: string;
  family: number;
}

export type PinnedLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: (err: Error | null, address?: string | LookupAddressLike[], family?: number) => void,
) => void;

// ── IP classification ──────────────────────────────────────────────────────────

/** 判断字符串是否为 IP literal（IPv4 / IPv6）。 */
export function isIpLiteral(hostname: string): boolean {
  return isIP(hostname) !== 0;
}

/** 分类单个 IP（仅接受合法 IPv4/IPv6 literal；非法输入保守判为 non-public）。 */
export function classifyIp(ip: string): IpClassification {
  const version = isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return 'non-public';
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  return parts[0] * 16777216 + parts[1] * 65536 + parts[2] * 256 + parts[3];
}

function classifyIpv4(ip: string): IpClassification {
  const n = ipv4ToNumber(ip);
  const octets = ip.split('.').map((p) => Number(p));
  // unspecified 0.0.0.0/8
  if (octets[0] === 0) return 'non-public';
  // 10.0.0.0/8 private
  if (octets[0] === 10) return 'non-public';
  // 100.64.0.0/10 CGNAT
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return 'non-public';
  // 127.0.0.0/8 loopback
  if (octets[0] === 127) return 'non-public';
  // 169.254.0.0/16 link-local
  if (octets[0] === 169 && octets[1] === 254) return 'non-public';
  // 172.16.0.0/12 private
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 'non-public';
  // 192.0.0.0/24 IETF protocol assignments（保留）
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) return 'non-public';
  // 192.0.2.0/24 TEST-NET-1 documentation
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) return 'non-public';
  // 192.168.0.0/16 private
  if (octets[0] === 192 && octets[1] === 168) return 'non-public';
  // 198.18.0.0/15 benchmark
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return 'non-public';
  // 198.51.100.0/24 TEST-NET-2 documentation
  if (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) return 'non-public';
  // 203.0.113.0/24 TEST-NET-3 documentation
  if (octets[0] === 203 && octets[1] === 0 && octets[2] === 113) return 'non-public';
  // 224.0.0.0/4 multicast
  if (n >= 3758096384 && n <= 4026531839) return 'non-public';
  // 240.0.0.0/4 reserved
  if (octets[0] >= 240) return 'non-public';
  // 255.255.255.255 broadcast
  if (octets[0] === 255 && octets[1] === 255 && octets[2] === 255 && octets[3] === 255) return 'non-public';
  return 'public';
}

function ipv6ToBytes(ip: string): number[] | null {
  const normalized = ip.toLowerCase();
  let head = normalized;
  let left: string[] = [];
  let right: string[] = [];
  const doubleColon = head.indexOf('::');
  if (doubleColon !== -1) {
    left = head.slice(0, doubleColon).split(':').filter((s) => s !== '');
    right = head.slice(doubleColon + 2).split(':').filter((s) => s !== '');
  } else {
    left = head.split(':');
  }
  const hextets: number[] = [];
  const parseHextet = (h: string): number | null => {
    if (h.length > 4) return null;
    const v = parseInt(h, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    return v;
  };
  for (const h of left) {
    const v = parseHextet(h);
    if (v === null) return null;
    hextets.push(v);
  }
  if (doubleColon !== -1) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    for (let i = 0; i < fill; i++) hextets.push(0);
  }
  for (const h of right) {
    const v = parseHextet(h);
    if (v === null) return null;
    hextets.push(v);
  }
  if (hextets.length !== 8) return null;
  const bytes: number[] = [];
  for (const h of hextets) {
    bytes.push((h >> 8) & 0xff, h & 0xff);
  }
  return bytes;
}

function classifyIpv6(ip: string): IpClassification {
  const normalized = ip.toLowerCase();
  // IPv4-mapped IPv6 ::ffff:a.b.c.d → 回查内嵌 IPv4
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (mapped && isIP(mapped[1]) === 4) return classifyIpv4(mapped[1]);

  const bytes = ipv6ToBytes(normalized);
  if (!bytes) return 'non-public';

  // :: (unspecified)
  if (bytes.every((b) => b === 0)) return 'non-public';
  // ::1 (loopback)
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return 'non-public';
  // fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'non-public';
  // fc00::/7 ULA
  if ((bytes[0] & 0xfe) === 0xfc) return 'non-public';
  // ff00::/8 multicast
  if (bytes[0] === 0xff) return 'non-public';
  // 2001:db8::/32 documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'non-public';
  // 100::/64 discard-only (RFC 6666)
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) return 'non-public';
  // Teredo 2001::/32
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return 'non-public';
  // 6to4 2002::/16 (RFC 3056) — 嵌入 IPv4，保守拒绝
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return 'non-public';
  return 'public';
}

// ── Hostname validation ────────────────────────────────────────────────────────

/**
 * 校验 hostname 是否可安全连接。
 *   - IP literal：不走 DNS，直接 classifyIp。
 *   - hostname：resolver.lookup（系统 getaddrinfo）→ 分类所有地址。
 * 返回 allowed（携带全部已校验 public 地址）、ssrf_blocked 或 dns_failure。
 * 当 signal 在解析期间 abort 时抛错（由上层映射为 TIMEOUT）。
 */
export async function validateHostname(
  hostname: string,
  resolver: DnsResolver,
  signal: AbortSignal,
): Promise<HostnameValidationResult> {
  if (isIpLiteral(hostname)) {
    const family = isIP(hostname) as IpFamily;
    if (classifyIp(hostname) === 'non-public') {
      return { kind: 'ssrf_blocked', reasonCode: 'non_public_ip_literal' };
    }
    return { kind: 'allowed', addresses: [{ address: hostname, family }] };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver.lookup(hostname, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    // resolver failure（ENOTFOUND / EAI_AGAIN 等）→ 无地址，映射 dns_failure
    return { kind: 'dns_failure', reasonCode: 'dns_resolution_failed' };
  }

  // deadline 已触发时，即使底层 lookup 晚返回，也丢弃结果，不继续后续网络副作用。
  if (signal.aborted) throw new Error('aborted');

  if (addresses.length === 0) {
    return { kind: 'dns_failure', reasonCode: 'dns_resolution_failed' };
  }
  if (addresses.some((a) => classifyIp(a.address) === 'non-public')) {
    return { kind: 'ssrf_blocked', reasonCode: 'non_public_resolved_ip' };
  }
  return { kind: 'allowed', addresses };
}

// ── Pinned lookup ──────────────────────────────────────────────────────────────

/**
 * 生成自定义 lookup：只返回已经完成安全校验的地址，绝不重新发起 DNS 查询。
 * 用于把 socket 连接钉在已校验 IP 上；Host / SNI / 证书校验仍由上层使用原 hostname。
 */
export function makePinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  return (_hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: string | LookupAddressLike[], family?: number) => void): void => {
    if (addresses.length === 0) {
      callback(new Error('no validated address available'));
      return;
    }
    // Node http(s) 在 autoSelectFamily（默认开启）下以 all:true 调用 lookup，期望地址数组。
    if (options.all) {
      callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      return;
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  };
}

// ── URL safety ─────────────────────────────────────────────────────────────────

/** 解析并校验 URL：必须是 http/https 且无 userinfo credentials。 */
export function parseAndValidateUrl(raw: string): UrlSafetyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: 'invalid', reasonCode: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'unsafe', reasonCode: 'unsupported_protocol' };
  }
  if (url.username !== '' || url.password !== '') {
    return { kind: 'unsafe', reasonCode: 'credentials_in_url' };
  }
  return { kind: 'ok', url };
}

// ── Real DNS resolver ──────────────────────────────────────────────────────────

/**
 * 真实 DNS resolver：使用系统名称解析设施（getaddrinfo），而非 dns.resolve* 的直连 DNS 查询。
 * 这是有意设计（与 Node/系统实际解析行为一致），返回全部 A/AAAA 候选地址供 IP classification。
 *
 * 说明：lookup 走系统 getaddrinfo / libuv threadpool，底层查询本身可能无法被真正 cancel；
 * 但通过 raceAgainstAbort + validateHostname 的 signal.aborted 检查，deadline 触发后即使底层
 * 晚返回，其结果也会被丢弃，不会继续 IP validation / HTTP connect，不会产生 double settlement。
 */
export function createNodeDnsResolver(): DnsResolver {
  return {
    async lookup(hostname: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
      const results = await raceAgainstAbort(
        dnsLookup(hostname, { all: true, order: 'verbatim' }),
        signal,
      );
      return results.map((r) => ({
        address: r.address,
        family: (r.family === 6 ? 6 : 4) as IpFamily,
      }));
    },
  };
}

function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
