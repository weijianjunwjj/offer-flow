/**
 * 上游转发：HTTP 请求代理到 CC Switch。
 * 所有认证 Header 只在内存中原样转发，禁止持久化、避免进入错误日志。
 */

import * as http from 'node:http';
import type { GatewayConfig } from './gatewayConfig';

/** 需要脱敏的 header 名称（大小写不敏感匹配）。 */
const REDACT_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'anthropic-auth-token',
  'cookie',
  'set-cookie',
]);

/** 脱敏 header 值（只保留长度和前缀类型）。 */
export function redactHeaderValue(key: string, value: string): string {
  const lower = key.toLowerCase();
  if (!REDACT_HEADERS.has(lower)) return value;
  if (lower === 'authorization') {
    if (value.startsWith('Bearer ')) return 'Bearer ***';
    if (value.startsWith('Basic ')) return 'Basic ***';
    return '***';
  }
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***';
}

/** 脱敏 URL 中的 query string（防止 token 出现在 URL 参数中）。 */
export function redactUrl(url: string): string {
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return url;
  return url.slice(0, qIndex) + '?[redacted]';
}

/**
 * 转发请求到 CC Switch 上游。
 * path 自动添加 `/claude-desktop` 前缀。
 */
export function forwardToUpstream(
  clientReq: http.IncomingMessage,
  _clientRes: http.ServerResponse,
  config: GatewayConfig,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string } | null> {
  return new Promise((resolve) => {
    const upstreamPath = config.upstreamPathPrefix + clientReq.url;
    const upstreamHeaders: Record<string, string> = {};

    // 转发所有 header（只读、不记录、不持久化）
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (value !== undefined) {
        upstreamHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    // 确保 host 指向 CC Switch
    upstreamHeaders['host'] = `${config.upstreamHost}:${config.upstreamPort}`;

    const upstreamReq = http.request(
      {
        hostname: config.upstreamHost,
        port: config.upstreamPort,
        path: upstreamPath,
        method: clientReq.method,
        headers: upstreamHeaders,
        timeout: 600_000, // 10 分钟超时
      },
      (upstreamRes) => {
        resolve({
          statusCode: upstreamRes.statusCode ?? 502,
          headers: upstreamRes.headers,
          body: '', // body 由流式场景单独处理
        });
      },
    );

    upstreamReq.on('error', (err) => {
      // 错误日志只记录 network 层信息，不包含认证 header
      console.error(`[gateway] upstream error: ${err.message}`);
      resolve(null);
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      console.error('[gateway] upstream timeout');
      resolve(null);
    });

    clientReq.pipe(upstreamReq);
  });
}
