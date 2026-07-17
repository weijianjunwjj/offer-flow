import type { FastifyError, FastifyInstance } from 'fastify';
import type { JobMemoryServiceDeps } from './jobMemoryService';
import { IdParamsSchema } from './dtoSchemas';
import { JobMemoryError, validationError } from './errors';
import { JobMemoryService } from './jobMemoryService';

export interface JobMemoryRouteOptions {
  serviceDeps?: JobMemoryServiceDeps;
}

function parseIdParams(value: unknown): string {
  const result = IdParamsSchema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data.id;
}

function handleJobMemoryError(
  error: FastifyError,
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof JobMemoryError) {
    return reply.code(error.statusCode).send(error.body);
  }
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return reply.code(400).send({
      code: 'INVALID_JSON',
      message: '请求体不是合法 JSON',
    });
  }
  return reply.code(500).send({
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
  });
}

export function registerJobMemoryRoutes(
  app: FastifyInstance,
  options: JobMemoryRouteOptions = {},
): void {
  app.register(async (scopedApp) => {
    const service = new JobMemoryService(scopedApp.db, options.serviceDeps);
    scopedApp.setErrorHandler(handleJobMemoryError);

    scopedApp.get('/resume-versions', async () => service.listResumeVersions());
    scopedApp.post('/resume-versions', async (request) => service.createResumeVersion(request.body));
    scopedApp.patch('/resume-versions/:id', async (request) => (
      service.updateResumeVersionMetadata(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/resume-versions/:id/activate', async (request) => (
      service.activateResumeVersion(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/resume-versions/:id/archive', async (request) => (
      service.archiveResumeVersion(parseIdParams(request.params), request.body)
    ));

    scopedApp.get('/jobs/summaries', async () => service.getJobSummaries());
    scopedApp.get('/jobs/:id/bundle', async (request) => (
      service.getJobDetailBundle(parseIdParams(request.params))
    ));
    scopedApp.post('/jobs/:id/applications', async (request) => (
      service.createApplication(parseIdParams(request.params), request.body)
    ));

    scopedApp.patch('/applications/:id', async (request) => (
      service.updateApplicationMetadata(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/applications/:id/void', async (request) => (
      service.voidApplication(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/applications/:id/events', async (request) => (
      service.appendFeedbackEvent(parseIdParams(request.params), request.body)
    ));

    scopedApp.post('/feedback-events/:id/void', async (request) => (
      service.voidFeedbackEvent(parseIdParams(request.params), request.body)
    ));
  });
}
