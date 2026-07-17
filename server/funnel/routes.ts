import type { FastifyError, FastifyInstance } from 'fastify';
import { FunnelError } from './errors';
import { FunnelService } from './service';

function handleFunnelError(
  error: FastifyError,
  _request: unknown,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
): unknown {
  if (error instanceof FunnelError) {
    return reply.code(error.statusCode).send(error.body);
  }
  return reply.code(500).send({
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
  });
}

export function registerFunnelRoutes(app: FastifyInstance): void {
  app.register(async (scopedApp) => {
    const service = new FunnelService({ db: scopedApp.db });
    scopedApp.setErrorHandler(handleFunnelError);

    scopedApp.get('/funnel', async (request) => service.getFunnel(request.query));
  });
}
