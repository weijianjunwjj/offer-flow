import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MarketPositionServiceDeps } from './service';
import { MarketPositionService } from './service';
import { MarketPositionError, invalidMarketPositionInput } from './errors';

const paramsSchema = z.strictObject({ id: z.string().trim().min(1).max(200) });

export function registerMarketPositionRoutes(
  app: FastifyInstance,
  deps: MarketPositionServiceDeps = {},
): void {
  app.register(async (scoped) => {
    const service = new MarketPositionService(scoped.db, deps);
    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof MarketPositionError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });
    const idFrom = (input: unknown): string => {
      const result = paramsSchema.safeParse(input);
      if (!result.success) throw invalidMarketPositionInput(result.error);
      return result.data.id;
    };

    scoped.get('/market-position', async () => service.getView());
    scoped.get('/market-position/input-snapshot', async () => service.buildCurrentInputSnapshot());
    scoped.post('/market-position/proposals/manual', async (request) => (
      service.createManualProposal(request.body)
    ));
    scoped.post('/market-position/proposals/:id/accept', async (request) => (
      service.acceptProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/market-position/proposals/:id/reject', async (request) => (
      service.rejectProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/market-position/proposals/:id/defer', async (request) => (
      service.deferProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/market-position/versions/:id/activate', async (request) => (
      service.activateVersion(idFrom(request.params), request.body)
    ));
  });
}
