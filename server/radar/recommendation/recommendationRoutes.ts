/**
 * V8-5 推荐批次 HTTP 接口（本波次只接出 API，不做前端/后台队列/SSE）。
 *
 * 安全与边界：
 * - 复用 Radar 采集桥安全网关（loopback + Host + Origin + x-offerflow-capture-client）——
 *   在父作用域（已装 preHandler 网关与 db 装饰）内再开子作用域注册，绝不复制第二套检查；
 * - 子作用域挂独立错误处理器：领域错误 → 安全 HTTP 码，绝不透传异常原文/分析全文/Provider 原文；
 * - 创建走幂等 batchKey：相同 scope + 相同分析/处理状态复用同一批次（不插第二份）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IdParamsSchema } from '../dtoSchemas';
import { RadarCaptureError } from '../errors';
import { RadarStorageCorruptionError } from '../errors';
import { RecommendationBatchService, type RecommendationBatchServiceDeps } from './recommendationBatchService';
import { RecommendationError, type RecommendationErrorCode } from './recommendationErrors';
import {
  CreateBatchRequestSchema,
  toRecommendationBatchView,
} from './recommendationDtoSchemas';
import { NovaWingContextError } from '../analysis/novaWingContext';

/** 可注入依赖（测试注入单调时钟/确定性 id）；db 由父作用域装饰提供。 */
export type RecommendationRouteDeps = Omit<RecommendationBatchServiceDeps, 'db'>;

export interface RadarRecommendationRouteOptions {
  recommendationDeps?: RecommendationRouteDeps;
}

class RecommendationHttpError extends Error {
  constructor(readonly statusCode: number, readonly body: { code: string; message: string }) {
    super(body.message);
    this.name = 'RecommendationHttpError';
  }
}

function badRequest(): RecommendationHttpError {
  return new RecommendationHttpError(400, { code: 'INVALID_PARAMS', message: '请求参数不合法' });
}

/** 领域错误 → 安全 HTTP 码：入参问题=400，候选不存在=404。 */
const ERROR_STATUS: Record<RecommendationErrorCode, number> = {
  SCOPE_EMPTY: 400,
  SCOPE_TOO_LARGE: 400,
  CANDIDATE_VERSION_NOT_FOUND: 404,
};

function handleRecommendationError(
  error: Error & { code?: string },
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof RecommendationHttpError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof RadarCaptureError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof RecommendationError) {
    return reply.code(ERROR_STATUS[error.code]).send({ code: error.code, message: error.message });
  }
  if (error instanceof RadarStorageCorruptionError) {
    return reply.code(500).send({ code: 'STORAGE_CORRUPTION', message: '存储记录损坏' });
  }
  if (error instanceof NovaWingContextError) {
    const status = error.code === 'NOVA_WING_CONTEXT_INVALID' || error.code === 'NOVA_WING_CONTEXT_TOO_LARGE'
      ? 422
      : 503;
    return reply.code(status).send({ code: error.code, message: error.message });
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply.code(400).send({ code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
  }
  console.error('[radar-recommendation] 未预期错误:', error?.name, error?.message);
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
}

function parseId(request: FastifyRequest): string {
  const result = IdParamsSchema.safeParse(request.params);
  if (!result.success) throw badRequest();
  return result.data.id;
}

/**
 * 在父作用域（已装 Radar 安全网关 preHandler 与 db 装饰）内开子作用域注册推荐路由。
 * 子作用域继承网关 hook，不复制安全检查；仅额外挂独立错误处理器与单一 Service 实例。
 */
export function registerRadarRecommendationRoutes(
  app: FastifyInstance,
  options: RadarRecommendationRouteOptions = {},
): void {
  app.register(async (scoped) => {
    const service = new RecommendationBatchService({ db: scoped.db, ...options.recommendationDeps });
    scoped.setErrorHandler(handleRecommendationError);

    // 生成/复用批次：相同 scope + 相同分析/处理状态幂等复用（201 新建 / 200 复用）。
    scoped.post('/radar/recommendation-batches', async (request, reply) => {
      const parsed = CreateBatchRequestSchema.safeParse(request.body);
      if (!parsed.success) throw badRequest();
      const { batch, created } = service.createBatch(parsed.data.candidateVersionIds);
      return reply.code(created ? 201 : 200).send(toRecommendationBatchView(batch));
    });

    scoped.get('/radar/recommendation-batches/:id', async (request, reply) => {
      const batch = service.getBatch(parseId(request));
      if (batch === null) {
        return reply.code(404).send({ code: 'BATCH_NOT_FOUND', message: '推荐批次不存在' });
      }
      return toRecommendationBatchView(batch);
    });

    scoped.get('/radar/recommendation-batches', async () => (
      service.listRecentBatches(20).map(toRecommendationBatchView)
    ));
  });
}
