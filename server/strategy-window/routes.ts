import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StrategyServiceDeps } from './service';
import { StrategyService } from './service';
import { StrategyError, invalidStrategyInput } from './errors';

const paramsSchema = z.strictObject({ id: z.string().trim().min(1).max(200) });

export function registerStrategyWindowRoutes(
  app: FastifyInstance,
  deps: StrategyServiceDeps = {},
): void {
  app.register(async (scoped) => {
    const service = new StrategyService(scoped.db, deps);
    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof StrategyError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });
    const idFrom = (input: unknown): string => {
      const result = paramsSchema.safeParse(input);
      if (!result.success) throw invalidStrategyInput(result.error);
      return result.data.id;
    };

    scoped.get('/strategy/current', async () => service.getView());
    scoped.get('/strategy/window', async () => {
      const view = service.getView();
      return { currentWindow: view.currentWindow, inputReady: view.inputReady };
    });
    scoped.get('/strategy/input-snapshot', async () => service.buildCurrentInputSnapshot());
    scoped.get('/strategy/proposals', async () => service.getView().state.proposals);
    scoped.get('/strategy/versions', async () => service.getView().state.versions);
    scoped.post('/strategy/proposals/generate', async (request) => {
      const controller = new AbortController();
      const socket = request.raw.socket;
      const abortOnDisconnect = (): void => controller.abort();
      socket.once('close', abortOnDisconnect);
      try {
        return await service.generateProposal(request.body, controller.signal);
      } finally {
        socket.off('close', abortOnDisconnect);
      }
    });
    scoped.post('/strategy/proposals/manual', async (request) => (
      service.createManualProposal(request.body)
    ));
    scoped.post('/strategy/proposals/:id/accept', async (request) => (
      service.acceptProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/strategy/proposals/:id/reject', async (request) => (
      service.rejectProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/strategy/proposals/:id/defer', async (request) => (
      service.deferProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/strategy/versions/:id/activate', async (request) => (
      service.activateVersion(idFrom(request.params), request.body)
    ));
  });
}
