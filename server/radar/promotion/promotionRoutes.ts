/**
 * V8-6 第二波 · 正式晋升 HTTP 接口（只接 API，不做前端/预览页/自动晋升）。
 *
 * 安全与边界：
 * - 复用 Radar 采集桥安全网关（loopback + Host + Origin + x-offerflow-capture-client）——
 *   在父作用域内再开子作用域注册，继承 preHandler，绝不复制第二套检查；
 * - 子作用域挂独立错误处理器：领域错误 → 稳定语义码 + 安全 HTTP 码，
 *   绝不透传异常原文 / JD 全文 / Provider 原文；
 * - 晋升永远由用户显式请求触发（Human-in-the-loop），无任何自动晋升入口。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IdParamsSchema } from '../dtoSchemas';
import { RadarCaptureError, RadarStorageCorruptionError } from '../errors';
import { PromotionService, type PromotionServiceDeps } from './promotionService';
import { PromotionError, type PromotionErrorCode } from './promotionErrors';
import {
  PromoteRequestSchema,
  toPromotionPlanView,
  toPromotionView,
} from './promotionDtoSchemas';

/** 可注入依赖（测试注入单调时钟/确定性 id）；db 由父作用域装饰提供。 */
export type PromotionRouteDeps = Omit<PromotionServiceDeps, 'db'>;

export interface RadarPromotionRouteOptions {
  promotionDeps?: PromotionRouteDeps;
}

class PromotionHttpError extends Error {
  constructor(readonly statusCode: number, readonly body: { code: string; message: string }) {
    super(body.message);
    this.name = 'PromotionHttpError';
  }
}

function badRequest(): PromotionHttpError {
  return new PromotionHttpError(400, { code: 'INVALID_PARAMS', message: '请求参数不合法' });
}

/**
 * 领域错误 → 安全 HTTP 码。
 * 409 用于"当前状态不允许"（非当前版本 / 触发原因不足 / 目标错配），
 * 与 400（入参格式错）和 404（对象不存在）区分开，便于前端分别提示。
 */
const ERROR_STATUS: Record<PromotionErrorCode, number> = {
  CANDIDATE_VERSION_NOT_FOUND: 404,
  CANDIDATE_VERSION_NOT_ACTIVE: 409,
  PROMOTION_TRIGGER_NOT_ALLOWED: 409,
  PROMOTION_TARGET_CONFLICT: 409,
};

function handlePromotionError(
  error: Error & { code?: string },
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof PromotionHttpError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof RadarCaptureError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof PromotionError) {
    return reply.code(ERROR_STATUS[error.code]).send({ code: error.code, message: error.message });
  }
  if (error instanceof RadarStorageCorruptionError) {
    return reply.code(500).send({ code: 'STORAGE_CORRUPTION', message: '存储记录损坏' });
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply.code(400).send({ code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
  }
  console.error('[radar-promotion] 未预期错误:', error?.name, error?.message);
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
}

function parseId(request: FastifyRequest): string {
  const result = IdParamsSchema.safeParse(request.params);
  if (!result.success) throw badRequest();
  return result.data.id;
}

/**
 * 在父作用域（已装 Radar 安全网关 preHandler 与 db 装饰）内开子作用域注册晋升路由。
 * 子作用域继承网关 hook，不复制安全检查；仅额外挂错误处理器与单一 Service 实例。
 */
export function registerRadarPromotionRoutes(
  app: FastifyInstance,
  options: RadarPromotionRouteOptions = {},
): void {
  app.register(async (scoped) => {
    const service = new PromotionService({ db: scoped.db, ...options.promotionDeps });
    scoped.setErrorHandler(handlePromotionError);

    // 晋升候选版本为正式记录：201 新建 / 200 幂等复用（复用时零新增正式对象）。
    scoped.post('/radar/candidate-versions/:id/promotions', async (request, reply) => {
      const parsed = PromoteRequestSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const { promotion, plan, created } = service.promote(parseId(request), parsed.data);
      return reply.code(created ? 201 : 200).send({
        promotion: toPromotionView(promotion),
        plan: toPromotionPlanView(plan),
        created,
      });
    });

    // 预览晋升计划：只读，零写入。与执行共用同一推导，保证"预览所见 = 确认所得"。
    // Human-in-the-loop 的关键一环：用户先看清会发生什么，再决定是否确认。
    scoped.post('/radar/candidate-versions/:id/promotions/preview', async (request, reply) => {
      const parsed = PromoteRequestSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const plan = service.previewPromotion(parseId(request), parsed.data);
      return reply.code(200).send({ plan: toPromotionPlanView(plan) });
    });

    scoped.get('/radar/promotions/:id', async (request, reply) => {
      const promotion = service.getPromotion(parseId(request));
      if (promotion === null) {
        return reply.code(404).send({ code: 'PROMOTION_NOT_FOUND', message: '晋升记录不存在' });
      }
      return toPromotionView(promotion);
    });

    scoped.get('/radar/candidates/:id/promotions', async (request) => (
      service.listByCandidate(parseId(request)).map(toPromotionView)
    ));
  });
}
