import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { IdParamsSchema } from './dtoSchemas';
import { RadarCaptureError, radarForbiddenOrigin, radarValidationError } from './errors';
import { RadarCaptureService, type RadarCaptureServiceDeps } from './service';

export type { RadarCaptureServiceDeps };

export interface RadarCaptureRouteOptions {
  serviceDeps?: RadarCaptureServiceDeps;
}

/**
 * 采集桥安全边界（docs/security/browser-capture-security.md §5.1, T-02/T-06）：
 * schema v7 未提供 token_hash/nonce 列（已核实，见 V8-2 决策记录），因此采集会话本身
 * 就是短期 capability（会话 ID 由 node:crypto randomUUID 生成，≥122 bit 随机性），
 * 但必须叠加以下非 schema 层控制：
 * - 只允许 loopback 地址访问；
 * - 严格 Host 校验（只接受 127.0.0.1 / localhost）；
 * - 自定义请求头（浏览器跨域简单请求无法携带，强制触发 CORS 预检）；
 * - Origin 允许列表（只允许扩展 origin 或无 Origin 的本机请求）；
 * - 会话状态机（preview→committed/cancelled/expired）保证 commit 后失效、可撤销；
 * - 日志不记录会话 ID 明文（仅记录截断后的指纹）。
 */
const CAPTURE_CLIENT_HEADER = 'x-offerflow-capture-client';

function parseIdParams(value: unknown): string {
  const result = IdParamsSchema.safeParse(value);
  if (!result.success) throw radarValidationError(result.error);
  return result.data.id;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isAllowedHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return isAllowedHost(parsed.hostname) || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
  } catch {
    return false;
  }
}

function assertCaptureRequestAllowed(request: FastifyRequest): void {
  if (!isLoopbackAddress(request.socket.remoteAddress ?? undefined)) {
    throw radarForbiddenOrigin();
  }
  if (!isAllowedHost(request.hostname)) {
    throw radarForbiddenOrigin();
  }
  if (!isAllowedOrigin(request.headers.origin)) {
    throw radarForbiddenOrigin();
  }
  if (request.headers[CAPTURE_CLIENT_HEADER] === undefined) {
    throw radarForbiddenOrigin();
  }
}

function handleRadarCaptureError(
  error: FastifyError,
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof RadarCaptureError) {
    return reply.code(error.statusCode).send(error.body);
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply.code(400).send({ code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
  }
  // 未预期错误：记录错误类型与栈以便定位，但绝不记录请求体/JD/会话 capability（T-05）。
  console.error('[radar] 未预期错误:', error?.name, error?.message, error?.stack);
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
}

export function registerRadarCaptureRoutes(
  app: FastifyInstance,
  options: RadarCaptureRouteOptions = {},
): void {
  app.register(async (scopedApp) => {
    const service = new RadarCaptureService(scopedApp.db, options.serviceDeps);
    scopedApp.setErrorHandler(handleRadarCaptureError);
    scopedApp.addHook('preHandler', async (request) => {
      assertCaptureRequestAllowed(request);
    });

    scopedApp.post('/radar/capture-sessions', async (request) => (
      service.createSession(request.body)
    ));
    scopedApp.get('/radar/capture-sessions/:id', async (request) => (
      service.getSessionView(parseIdParams(request.params))
    ));
    scopedApp.post('/radar/capture-sessions/:id/items', async (request) => (
      service.addItem(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/radar/capture-sessions/:id/commit', async (request) => (
      service.commitSession(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/radar/capture-sessions/:id/cancel', async (request) => (
      service.cancelSession(parseIdParams(request.params), request.body)
    ));
  });
}
