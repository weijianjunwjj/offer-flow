/**
 * V8-4 单岗位分析 HTTP 接口（本波次只接出 API，不做前端/后台队列/SSE）。
 *
 * 安全与边界：
 * - 复用 Radar 采集桥安全网关（loopback + Host + Origin + x-offerflow-capture-client）——
 *   本文件在父作用域（已装好 preHandler 网关与 db 装饰）内再开子作用域注册，绝不复制第二套检查；
 * - 子作用域挂独立错误处理器：把领域错误统一映射为安全 HTTP 码，绝不透传异常原文/快照/Provider 原文；
 * - run 仅供沙箱/测试显式触发，同步等待本次执行结束后返回最新 Task View；失败是任务终态（仍 200），
 *   非 HTTP 错误；HTTP 4xx/5xx 只用于「抛出的」领域错误。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IdParamsSchema } from '../dtoSchemas';
import { RadarCaptureError } from '../errors';
import { RadarCandidateRepository } from '../candidateRepository';
import { AnalysisService, type AnalysisServiceDeps } from './analysisService';
import { AnalysisInputError, type AnalysisInputErrorCode } from './inputErrors';
import { AnalysisTaskDomainError, type AnalysisTaskDomainErrorCode, taskNotFound } from './errors';
import { AnalysisProviderError, type AnalysisProviderErrorCode } from './provider';
import { AnalysisContractError } from './contractErrors';
import { toAnalysisTaskView, toAnalysisRecordView } from './analysisDtoSchemas';

/** 可注入依赖：测试必须注入 fake provider（禁止读真实 key / 访问外网）。db 由父作用域装饰提供。 */
export type AnalysisRouteDeps = Omit<AnalysisServiceDeps, 'db'>;

export interface RadarAnalysisRouteOptions {
  analysisDeps?: AnalysisRouteDeps;
}

class AnalysisHttpError extends Error {
  constructor(readonly statusCode: number, readonly body: { code: string; message: string }) {
    super(body.message);
    this.name = 'AnalysisHttpError';
  }
}

function badRequest(): AnalysisHttpError {
  return new AnalysisHttpError(400, { code: 'INVALID_PARAMS', message: '请求参数不合法' });
}

/** 输入组装错误 → 安全 HTTP 码（不存在=404，版本非当前正式=409 状态冲突，其余就绪性问题=422）。 */
const INPUT_ERROR_STATUS: Record<AnalysisInputErrorCode, number> = {
  CANDIDATE_NOT_FOUND: 404,
  CANDIDATE_VERSION_NOT_FOUND: 404,
  CANDIDATE_VERSION_MISMATCH: 409,
  CANDIDATE_NOT_ANALYZABLE: 422,
  ACTIVE_RESUME_REQUIRED: 422,
  ACTIVE_PROFILE_REQUIRED: 422,
  INPUT_NOT_READY: 422,
};

/** 任务领域错误 → 安全 HTTP 码（不存在=404，状态/并发/次数冲突=409）。 */
const TASK_ERROR_STATUS: Record<AnalysisTaskDomainErrorCode, number> = {
  TASK_NOT_FOUND: 404,
  INVALID_TASK_TRANSITION: 409,
  TASK_ATTEMPTS_EXHAUSTED: 409,
  TASK_INPUT_CONFLICT: 409,
  TASK_RESULT_CONFLICT: 409,
  TASK_STATE_CONFLICT: 409,
};

/** Provider 错误 → 安全 HTTP 码（传输/配置类不可用=503，结构/内容/泄漏类=422，取消=409）。 */
const PROVIDER_ERROR_STATUS: Record<AnalysisProviderErrorCode, number> = {
  PROVIDER_TIMEOUT: 503,
  PROVIDER_NETWORK_ERROR: 503,
  PROVIDER_RATE_LIMIT: 503,
  CONFIGURATION_ERROR: 503,
  SCHEMA_INVALID: 422,
  STRUCTURE_REPAIR_FAILED: 422,
  SENSITIVE_CONTENT_LEAK: 422,
  INTERNAL_ID_LEAK: 422,
  CANCELLED_BY_USER: 409,
};

/** 统一错误处理：把已知领域错误映射为安全 HTTP 码，未知错误一律 500 通用文案（不透传原文）。 */
function handleAnalysisError(
  error: Error & { code?: string },
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof AnalysisHttpError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof RadarCaptureError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof AnalysisInputError) {
    return reply.code(INPUT_ERROR_STATUS[error.code]).send({ code: error.code, message: error.message });
  }
  if (error instanceof AnalysisTaskDomainError) {
    return reply.code(TASK_ERROR_STATUS[error.code]).send({ code: error.code, message: error.message });
  }
  if (error instanceof AnalysisProviderError) {
    return reply.code(PROVIDER_ERROR_STATUS[error.code]).send({ code: error.code, message: error.message });
  }
  if (error instanceof AnalysisContractError) {
    return reply.code(422).send({ code: error.code, message: error.message });
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply.code(400).send({ code: 'INVALID_JSON', message: '请求体不是合法 JSON' });
  }
  console.error('[radar-analysis] 未预期错误:', error?.name, error?.message);
  return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
}

function parseId(request: FastifyRequest): string {
  const result = IdParamsSchema.safeParse(request.params);
  if (!result.success) throw badRequest();
  return result.data.id;
}

/**
 * 在父作用域（已装 Radar 安全网关 preHandler 与 db 装饰）内开子作用域注册分析路由。
 * 子作用域继承网关 hook，不复制安全检查；仅额外挂独立错误处理器与单一 AnalysisService 实例
 * （其执行器进程内 inflight 取消登记需跨 run/cancel 请求共享，故只 new 一次）。
 */
export function registerRadarAnalysisRoutes(app: FastifyInstance, options: RadarAnalysisRouteOptions = {}): void {
  app.register(async (scoped) => {
    const service = new AnalysisService({ db: scoped.db, ...options.analysisDeps });
    scoped.setErrorHandler(handleAnalysisError);

    /** 有效性投影：复用服务派生逻辑，按 record 定位其视图。 */
    const analysisView = (analysisId: string) => {
      const record = service.getAnalysis(analysisId);
      if (record === null) throw new AnalysisInputError('CANDIDATE_NOT_FOUND', '分析记录不存在');
      const view = service.listCandidateAnalyses(record.candidateId).find((v) => v.record.id === analysisId);
      const validity = view?.validity ?? { status: 'stale' as const, staleReasons: [] };
      return toAnalysisRecordView(record, validity);
    };

    // 创建/复用 queued 任务：只组装固定输入，绝不调用模型、绝不自动运行；相同输入幂等返回同一 task。
    scoped.post('/radar/candidate-versions/:id/analysis-tasks', async (request, reply) => {
      const { task } = service.createTask(parseId(request));
      return reply.code(200).send(toAnalysisTaskView(task));
    });

    scoped.get('/radar/analysis-tasks/:id', async (request) => {
      const task = service.getTask(parseId(request));
      if (task === null) throw taskNotFound();
      return toAnalysisTaskView(task);
    });

    // 显式执行（仅沙箱/测试触发）：同步等待本次执行结束，返回最新 Task View；失败为终态仍 200。
    scoped.post('/radar/analysis-tasks/:id/run', async (request) => {
      const id = parseId(request);
      if (service.getTask(id) === null) throw taskNotFound();
      await service.runTask(id);
      return toAnalysisTaskView(service.getTask(id)!);
    });

    scoped.post('/radar/analysis-tasks/:id/retry', async (request) => {
      const id = parseId(request);
      if (service.getTask(id) === null) throw taskNotFound();
      return toAnalysisTaskView(service.retryTask(id));
    });

    scoped.post('/radar/analysis-tasks/:id/cancel', async (request) => {
      const id = parseId(request);
      if (service.getTask(id) === null) throw taskNotFound();
      return toAnalysisTaskView(service.cancelTask(id));
    });

    scoped.get('/radar/candidates/:id/analyses', async (request) => {
      const id = parseId(request);
      if (new RadarCandidateRepository(scoped.db).getCandidate(id) === null) {
        throw new AnalysisInputError('CANDIDATE_NOT_FOUND', '候选不存在');
      }
      return service.listCandidateAnalyses(id).map((v) => toAnalysisRecordView(v.record, v.validity));
    });

    scoped.get('/radar/analyses/:id', async (request) => analysisView(parseId(request)));
  });
}
