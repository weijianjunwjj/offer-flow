/**
 * v0.9 Phase 4C-2 — OpenWebContentFetcher（node:http / node:https transport 编排）。
 *
 * 设计依据：Phase 4C-2 Implementation Scope Lock v3。
 *
 * 权威运行时流程（本阶段到此停止）：
 *   Source Policy 二次校验 → URL safety → DNS/SSRF → 有界 GET（manual redirect）→
 *   content-encoding 解压 → charset 解码 → HTML 提取 → Evidence Validation → FETCHED。
 *
 * 硬不变量：
 *   - fetch success != FULL_EVIDENCE；PASS 只表示 eligible for future evidence_upgrade。
 *   - 不写 DB、不执行 evidence_upgrade、不调用 AnalysisService、不创建 RecommendationBatch。
 *   - raw HTML 仅 transient；不进入 ExtractedContent / FetchResult / DB。
 *   - 30s 是总体 I/O deadline（跨 redirect），单次 AbortController + 单次 timer。
 *   - custom lookup 只返回已校验 IP，绝不重新 DNS；Host/SNI/证书校验仍用原 hostname。
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions as HttpRequestOptions } from 'node:http';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { getSourcePolicyDecision } from '../radar/sourcePolicy/sourcePolicy';
import type { ContentFetcher } from './ContentFetcher';
import type { ContentFetchError, ContentFetchErrorCode } from './errors';
import type { ContentFetchRequest, ExtractedContent, FetchResult } from './types';
import { decodeContentText } from './charsetDecode';
import { validateEvidence } from './evidenceValidation';
import { extractContent } from './htmlExtraction';
import {
  makePinnedLookup,
  parseAndValidateUrl,
  validateHostname,
  type DnsResolver,
  type PinnedLookup,
} from './ssrfGuard';

// ── 可调实现级默认常量（非业务不变量，不进 evidence model） ────────────────────

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_WIRE_BYTES = 512 * 1024;
export const DEFAULT_MAX_DECODED_BYTES = 512 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_CONTENT_ENCODINGS = new Set(['identity', 'gzip', 'deflate', 'br']);
const SUPPORTED_MIME = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

// ── Transport seam（注入以便测试；真实实现为 node:http/https） ──────────────────

export interface TransportRequestOptions {
  url: URL;
  headers: Record<string, string>;
  /** 只返回已校验地址、绝不重新 DNS 的 pinned lookup。 */
  lookup: PinnedLookup;
  /** HTTPS SNI / 证书校验使用的原始 hostname。 */
  servername: string;
  signal: AbortSignal;
}

export interface TransportResponse {
  statusCode: number;
  /** 小写 header 名 → 值。 */
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
  /** 中断底层连接 / 流（超限或提前终止时调用）。 */
  cancel(): void;
}

export type TransportRequest = (options: TransportRequestOptions) => Promise<TransportResponse>;

// ── Dependencies / factory ─────────────────────────────────────────────────────

export interface OpenWebContentFetcherDeps {
  resolver: DnsResolver;
  transport: TransportRequest;
  timeoutMs?: number;
  maxWireBytes?: number;
  maxDecodedBytes?: number;
  maxRedirects?: number;
}

export function createOpenWebContentFetcher(deps: OpenWebContentFetcherDeps): ContentFetcher {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxWireBytes = deps.maxWireBytes ?? DEFAULT_MAX_WIRE_BYTES;
  const maxDecodedBytes = deps.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return {
    async fetch(request: ContentFetchRequest): Promise<FetchResult> {
      return await acquireContent(request, {
        resolver: deps.resolver,
        transport: deps.transport,
        timeoutMs,
        maxWireBytes,
        maxDecodedBytes,
        maxRedirects,
      });
    },
  };
}

interface ResolvedConfig {
  resolver: DnsResolver;
  transport: TransportRequest;
  timeoutMs: number;
  maxWireBytes: number;
  maxDecodedBytes: number;
  maxRedirects: number;
}

// ── Main orchestration ─────────────────────────────────────────────────────────

async function acquireContent(request: ContentFetchRequest, config: ResolvedConfig): Promise<FetchResult> {
  // 30s 是总体 I/O deadline：单次 timer + 单次 AbortController，跨 redirect 不重置。
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  try {
    let currentUrl = request.url;
    let previousProtocol: string | null = null;

    for (let hop = 0; hop <= config.maxRedirects; hop++) {
      // —— Source Policy 运行时二次校验（不信 request.sourcePolicy / normalizedDomain）——
      const decision = getSourcePolicyDecision(currentUrl);
      if (!decision.fetchEligible) {
        return failed('BLOCKED_BY_POLICY', 'policy_blocked', decision.reason);
      }

      // —— URL safety（protocol / credentials）——
      const parsed = parseAndValidateUrl(currentUrl);
      if (parsed.kind !== 'ok') {
        if (hop === 0) {
          return failed('PARSE_FAILED', parsed.reasonCode, `initial URL rejected: ${parsed.reasonCode}`);
        }
        return failed('REDIRECT_BLOCKED', parsed.reasonCode, `redirect rejected: ${parsed.reasonCode}`);
      }
      const url = parsed.url;

      // —— HTTPS → HTTP downgrade 拒绝 ——
      if (previousProtocol === 'https:' && url.protocol === 'http:') {
        return failed('REDIRECT_BLOCKED', 'https_downgrade_blocked', 'redirect would downgrade https to http');
      }

      // —— DNS / SSRF ——
      let resolved;
      try {
        resolved = await validateHostname(url.hostname, config.resolver, controller.signal);
      } catch {
        if (timedOut) return failed('TIMEOUT', 'timeout', 'overall deadline exceeded during DNS resolution');
        return failed('NETWORK_ERROR', 'dns_resolution_failed', 'DNS resolution failed');
      }
      if (resolved.kind === 'ssrf_blocked') {
        return failed('SSRF_BLOCKED', resolved.reasonCode, 'host resolves to a non-public address');
      }
      if (resolved.kind === 'dns_failure') {
        if (timedOut) return failed('TIMEOUT', 'timeout', 'overall deadline exceeded during DNS resolution');
        return failed('NETWORK_ERROR', 'dns_resolution_failed', 'DNS resolution returned no addresses');
      }

      // —— transport（node:http/https + pinned lookup）——
      let response: TransportResponse;
      try {
        response = await config.transport({
          url,
          headers: {
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
            'accept-encoding': 'gzip, deflate, br',
            'user-agent': 'OfferFlow-ContentAcquisition/0.8 (read-only)',
          },
          lookup: makePinnedLookup(resolved.addresses),
          servername: url.hostname,
          signal: controller.signal,
        });
      } catch {
        if (timedOut) return failed('TIMEOUT', 'timeout', 'overall deadline exceeded during transport');
        return failed('NETWORK_ERROR', 'network_error', 'transport request failed');
      }

      // —— redirect：逐跳重新执行（下一轮循环回到 Source Policy 校验）——
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        const location = response.headers['location'];
        const locationValue = location && location.trim() !== '' ? location.trim() : null;
        response.cancel();
        if (locationValue === null) {
          return failed('REDIRECT_BLOCKED', 'redirect_no_location', 'redirect response missing Location header');
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(locationValue, url).toString();
        } catch {
          return failed('REDIRECT_BLOCKED', 'invalid_redirect_location', 'invalid redirect Location');
        }
        previousProtocol = url.protocol;
        currentUrl = nextUrl;
        continue;
      }

      // —— HTTP status 映射 ——
      if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 407) {
        response.cancel();
        return failed('ACCESS_DENIED', `http_${response.statusCode}`, `HTTP ${response.statusCode}`);
      }
      if (response.statusCode === 404 || response.statusCode === 410) {
        response.cancel();
        return failed('NOT_FOUND', `http_${response.statusCode}`, `HTTP ${response.statusCode}`);
      }
      if (response.statusCode >= 500) {
        response.cancel();
        return failed('NETWORK_ERROR', `http_${response.statusCode}`, `HTTP ${response.statusCode}`);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        // 其他非 2xx（如 429 等）：不静默映射，保守记为 NETWORK_ERROR + 明确 reasonCode。
        response.cancel();
        return failed('NETWORK_ERROR', `unexpected_http_status_${response.statusCode}`, `unexpected HTTP status ${response.statusCode}`);
      }

      // —— content-type ——
      const contentTypeHeader = response.headers['content-type'];
      const mime = extractMime(contentTypeHeader);
      if (mime !== null && !SUPPORTED_MIME.has(mime)) {
        response.cancel();
        return failed('UNSUPPORTED_CONTENT', 'unsupported_content_type', `unsupported content type: ${mime}`);
      }

      // —— Content-Length 提前拒绝（仅提示；最终仍以 stream counter 为权威 gate）——
      const declaredLength = parseContentLength(response.headers['content-length']);
      if (declaredLength !== null && declaredLength > config.maxWireBytes) {
        response.cancel();
        return failed('RESPONSE_TOO_LARGE', 'wire_response_too_large', 'declared Content-Length exceeds size limit');
      }

      // —— wire bytes（有界流式读取）——
      let wire: BoundedReadResult;
      try {
        wire = await readBounded(response.body, config.maxWireBytes, controller.signal);
      } catch {
        if (timedOut) return failed('TIMEOUT', 'timeout', 'overall deadline exceeded during body read');
        return failed('NETWORK_ERROR', 'network_error', 'body read failed');
      }
      if (wire.kind === 'too_large') {
        response.cancel();
        return failed('RESPONSE_TOO_LARGE', 'wire_response_too_large', 'wire response exceeds size limit');
      }
      if (wire.kind === 'aborted') {
        return failed('TIMEOUT', 'timeout', 'overall deadline exceeded during body read');
      }

      // —— content-encoding 解压（有界，防 decompression bomb）——
      const decoded = await decodeContentEncoding(wire.data, response.headers['content-encoding'], config.maxDecodedBytes);
      if (decoded.kind === 'unsupported') {
        return failed('UNSUPPORTED_CONTENT', 'unsupported_content_encoding', `unsupported content encoding: ${decoded.encoding}`);
      }
      if (decoded.kind === 'too_large') {
        return failed('RESPONSE_TOO_LARGE', 'decoded_response_too_large', 'decoded response exceeds size limit');
      }
      if (decoded.kind === 'error') {
        return failed('NETWORK_ERROR', 'content_decoding_failed', 'failed to decompress response body');
      }

      // —— charset 解码 ——
      const text = decodeContentText(decoded.data, contentTypeHeader);
      if (text.kind === 'unsupported_charset') {
        return failed('UNSUPPORTED_CHARSET', `unsupported_charset_${text.label}`, `unsupported charset: ${text.label}`);
      }
      if (text.kind === 'decode_failed') {
        return failed('DECODE_FAILED', `decode_failed_${text.label}`, `failed to decode body as ${text.label}`);
      }

      // —— HTML 提取 ——
      let content: ExtractedContent;
      try {
        content = extractContent(text.text, mime);
      } catch {
        return failed('PARSE_FAILED', 'html_extraction_failed', 'failed to parse HTML');
      }

      // —— Evidence Validation ——
      const validation = validateEvidence(content);

      return { status: 'FETCHED', content, validation };
    }

    return failed('REDIRECT_BLOCKED', 'too_many_redirects', 'redirect limit exceeded');
  } finally {
    clearTimeout(timer);
  }
}

// ── Bounded byte reading ───────────────────────────────────────────────────────

export type BoundedReadResult =
  | { kind: 'ok'; data: Buffer }
  | { kind: 'too_large' }
  | { kind: 'aborted' };

/**
 * 流式读取并计数；超限返回 too_large（调用方负责 cancel）。
 * signal abort 时返回 aborted（不把 timeout 误映射为 NETWORK_ERROR）。
 */
export async function readBounded(
  body: AsyncIterable<Buffer>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      if (signal.aborted) return { kind: 'aborted' };
      total += chunk.length;
      if (total > maxBytes) {
        return { kind: 'too_large' };
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (signal.aborted) return { kind: 'aborted' };
    throw e;
  }
  if (signal.aborted) return { kind: 'aborted' };
  return { kind: 'ok', data: Buffer.concat(chunks) };
}

// ── Content-Encoding decompression ─────────────────────────────────────────────

export type ContentDecodeResult =
  | { kind: 'ok'; data: Buffer }
  | { kind: 'unsupported'; encoding: string }
  | { kind: 'too_large' }
  | { kind: 'error'; encoding: string };

/** 仅支持 identity / gzip / deflate / br；未知 encoding 稳定失败（unsupported）。 */
export async function decodeContentEncoding(
  data: Buffer,
  contentEncodingHeader: string | null | undefined,
  maxDecodedBytes: number,
): Promise<ContentDecodeResult> {
  const encoding = (contentEncodingHeader ?? '').trim().toLowerCase();
  if (encoding === '' || encoding === 'identity') {
    return { kind: 'ok', data };
  }
  if (!SUPPORTED_CONTENT_ENCODINGS.has(encoding)) {
    return { kind: 'unsupported', encoding };
  }
  try {
    return await decompress(data, encoding, maxDecodedBytes);
  } catch {
    return { kind: 'error', encoding };
  }
}

async function decompress(data: Buffer, encoding: string, maxBytes: number): Promise<ContentDecodeResult> {
  const transform = pickTransform(encoding);
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        transform.removeListener('data', onData);
        transform.destroy();
        resolve();
        return;
      }
      chunks.push(chunk);
    };
    transform.on('data', onData);
    transform.once('end', () => resolve());
    transform.once('error', (e) => {
      if (!overflowed) reject(e);
    });
    transform.end(data);
  });

  if (overflowed) return { kind: 'too_large' };
  return { kind: 'ok', data: Buffer.concat(chunks) };
}

function pickTransform(encoding: string) {
  switch (encoding) {
    case 'gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      // SUPPORTED_CONTENT_ENCODINGS 已保证不会到达这里
      throw new Error(`unsupported encoding: ${encoding}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractMime(contentTypeHeader: string | null | undefined): string | null {
  if (!contentTypeHeader) return null;
  const mime = contentTypeHeader.split(';')[0].trim().toLowerCase();
  return mime === '' ? null : mime;
}

function parseContentLength(header: string | null | undefined): number | null {
  if (!header) return null;
  const value = Number(header.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function contentFetchError(code: ContentFetchErrorCode, reasonCode: string, reason: string): ContentFetchError {
  return { code, reasonCode, reason };
}

/**
 * 构造失败结果。`status` 恒等于 `code`，且所有非 FETCHED 分支形状一致，
 * 因此这里的 `as FetchResult` 是安全的结构性收窄。
 */
function failed(code: ContentFetchErrorCode, reasonCode: string, reason: string): FetchResult {
  const error = contentFetchError(code, reasonCode, reason);
  return { status: code, error } as FetchResult;
}

// ── Real transport（node:http / node:https） ───────────────────────────────────

export function nodeTransportRequest(options: TransportRequestOptions): Promise<TransportResponse> {
  return new Promise<TransportResponse>((resolve, reject) => {
    const { url } = options;
    const isHttps = url.protocol === 'https:';
    const portNumber = url.port !== '' ? Number(url.port) : undefined;
    const path = url.pathname + url.search;

    const common: HttpRequestOptions = {
      hostname: url.hostname,
      port: portNumber,
      path,
      method: 'GET',
      headers: options.headers,
      lookup: options.lookup as unknown as HttpRequestOptions['lookup'],
      signal: options.signal,
    };

    let req: ClientRequest;

    const onResponse = (res: IncomingMessage): void => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
      }
      resolve({
        statusCode: res.statusCode ?? 0,
        headers,
        body: res as AsyncIterable<Buffer>,
        cancel: () => req.destroy(),
      });
    };

    if (isHttps) {
      // servername 保持原 hostname：socket 连已校验 IP，SNI / 证书校验仍用 hostname。
      req = httpsRequest({ ...common, servername: options.servername } as HttpsRequestOptions, onResponse);
    } else {
      req = httpRequest(common, onResponse);
    }

    req.on('error', reject);
    req.end();
  });
}
