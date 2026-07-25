import { randomUUID } from 'node:crypto';
import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { getDatabaseSchemaVersion, RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION } from '../migrations';
import { IdParamsSchema } from './dtoSchemas';
import { RadarCaptureError, radarForbiddenOrigin, radarValidationError } from './errors';
import { RadarCaptureService, type RadarCaptureServiceDeps } from './service';
import { RadarReviewService } from './reviewService';
import { registerRadarAnalysisRoutes, type AnalysisRouteDeps } from './analysis/analysisRoutes';
import { RADAR_DOMAIN_SCHEMA_VERSION } from '../migrations';
import {
  AdjudicationRequestSchema,
  RecheckRequestSchema,
  RelationListQuerySchema,
  RuleOverrideRevertRequestSchema,
  RuleOverrideSetRequestSchema,
} from './reviewDtoSchemas';
import type { ZodType } from 'zod';

export type { RadarCaptureServiceDeps };

export interface RadarCaptureRouteOptions {
  serviceDeps?: RadarCaptureServiceDeps;
  /** V8-4 单岗位分析 API 门禁：默认关闭；需 radar 已启用 + schema ≥ v7 才注册。 */
  analysisEnabled?: boolean;
  analysisDeps?: AnalysisRouteDeps;
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

function parseReviewDto<Output>(schema: ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw radarValidationError(result.error);
  return result.data;
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

    // ---- V8-4 单岗位分析 API（独立门禁）：需 analysisEnabled 且 schema ≥ v7（分析领域表随 v7 落地）。 ----
    // 分析只依赖 v7 雷达领域表，早于 v8 评审门禁注册，确保 v7 库亦可接出；生产入口默认不开启。
    if (options.analysisEnabled === true && getDatabaseSchemaVersion(scopedApp.db) >= RADAR_DOMAIN_SCHEMA_VERSION) {
      registerRadarAnalysisRoutes(scopedApp, { analysisDeps: options.analysisDeps });
    }

    // ---- V8-3 人工评审工作台（只读详情 + 关系裁决 + 规则证据/覆盖），共用同一安全网关 ----
    // 评审依赖 v8 候选关系表（radar_candidate_relations）。采集桥的最低 schema 为 v7；
    // v8 属受控激活（设计文档 BR-1），未激活前不注册评审路由，避免运行时 "no such table"，
    // 也不擅自把 Radar 能力整体拉到 v8。schema ≥ v8 时（沙箱/演练/已授权库）才挂载评审接口。
    if (getDatabaseSchemaVersion(scopedApp.db) < RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION) {
      return;
    }
    const review = new RadarReviewService(scopedApp.db, options.serviceDeps ?? { now: Date.now, createId: randomUUID });
    const actor = 'reviewer';

    scopedApp.get('/radar/review/candidates/:id', async (request) => (
      review.getCandidateDecisionDetail(parseIdParams(request.params))
    ));
    scopedApp.get('/radar/review/candidate-versions/:id/rule-evidence', async (request) => (
      review.listRuleEvidence(parseIdParams(request.params))
    ));
    scopedApp.get('/radar/review/relations', async (request) => (
      review.listRelations(parseReviewDto(RelationListQuerySchema, request.query ?? {}))
    ));
    scopedApp.get('/radar/review/relations/:id', async (request) => (
      review.getRelationDetail(parseIdParams(request.params))
    ));
    scopedApp.get('/radar/review/decision-feed', async () => (
      review.listDecisionFeed()
    ));
    scopedApp.post('/radar/review/relations/confirm-same', async (request) => (
      review.confirmSame(parseReviewDto(AdjudicationRequestSchema, request.body))
    ));
    scopedApp.post('/radar/review/relations/confirm-distinct', async (request) => (
      review.confirmDistinct(parseReviewDto(AdjudicationRequestSchema, request.body))
    ));
    scopedApp.post('/radar/review/relations/revert', async (request) => (
      review.revertDecision(parseReviewDto(AdjudicationRequestSchema, request.body))
    ));
    scopedApp.post('/radar/review/relations/request-recheck', async (request) => (
      review.requestRecheck(parseReviewDto(RecheckRequestSchema, request.body))
    ));
    scopedApp.post('/radar/review/rule-overrides/set', async (request) => (
      review.setRuleOverride(parseReviewDto(RuleOverrideSetRequestSchema, request.body), actor)
    ));
    scopedApp.post('/radar/review/rule-overrides/revert', async (request) => (
      review.revertRuleOverride(parseReviewDto(RuleOverrideRevertRequestSchema, request.body), actor)
    ));
  });
}
