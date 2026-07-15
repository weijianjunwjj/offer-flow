import type { FastifyError, FastifyInstance } from 'fastify';
import { IdParamsSchema } from './dtoSchemas';
import { HistoryImportError, validationError } from './errors';
import { HistoryImportService, type HistoryImportServiceDeps } from './service';

export interface HistoryImportRouteOptions {
  serviceDeps?: HistoryImportServiceDeps;
}

function parseIdParams(value: unknown): string {
  const result = IdParamsSchema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data.id;
}

function handleHistoryImportError(
  error: FastifyError,
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof HistoryImportError) {
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

export function registerHistoryImportRoutes(
  app: FastifyInstance,
  options: HistoryImportRouteOptions = {},
): void {
  app.register(async (scopedApp) => {
    const service = new HistoryImportService(scopedApp.db, options.serviceDeps);
    scopedApp.setErrorHandler(handleHistoryImportError);

    scopedApp.get('/history-import/sessions', async () => service.listSessions());
    scopedApp.post('/history-import/sessions', async () => service.createSession());
    scopedApp.get('/history-import/sessions/:id', async (request) => (
      service.getSessionBundle(parseIdParams(request.params))
    ));
    scopedApp.post('/history-import/sessions/:id/preview', async (request) => (
      service.markPreviewGenerated(
        parseIdParams(request.params),
        (request.body as { expectedVersion: number }).expectedVersion,
      )
    ));
    scopedApp.post('/history-import/sessions/:id/confirm', async (request) => (
      service.confirmSession(parseIdParams(request.params), request.body)
    ));
    scopedApp.post('/history-import/sessions/:id/discard', async (request) => (
      service.discardSession(parseIdParams(request.params), request.body)
    ));

    scopedApp.post('/history-import/sessions/:id/baseline-drafts', async (request) => (
      service.createBaselineDraft(parseIdParams(request.params), request.body)
    ));
    scopedApp.patch('/history-import/baseline-drafts/:id', async (request) => (
      service.updateBaselineDraft(parseIdParams(request.params), request.body)
    ));
    scopedApp.delete('/history-import/baseline-drafts/:id', async (request) => {
      service.deleteBaselineDraft(parseIdParams(request.params));
      return { ok: true };
    });

    scopedApp.post('/history-import/baseline-drafts/:id/event-drafts', async (request) => (
      service.createEventDraft(parseIdParams(request.params), request.body)
    ));
    scopedApp.patch('/history-import/event-drafts/:id', async (request) => (
      service.updateEventDraft(parseIdParams(request.params), request.body)
    ));
    scopedApp.delete('/history-import/event-drafts/:id', async (request) => {
      service.deleteEventDraft(parseIdParams(request.params));
      return { ok: true };
    });
  });
}
