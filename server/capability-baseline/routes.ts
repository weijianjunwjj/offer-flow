import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CapabilityBaselineServiceDeps } from './service';
import { CapabilityBaselineService } from './service';
import { CapabilityBaselineError, invalidCapabilityInput } from './errors';

const paramsSchema = z.strictObject({ id: z.string().trim().min(1).max(200) });

export function registerCapabilityBaselineRoutes(
  app: FastifyInstance,
  deps: CapabilityBaselineServiceDeps = {},
): void {
  app.register(async (scoped) => {
    const service = new CapabilityBaselineService(scoped.db, deps);
    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof CapabilityBaselineError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });
    const idFrom = (input: unknown): string => {
      const result = paramsSchema.safeParse(input);
      if (!result.success) throw invalidCapabilityInput(result.error);
      return result.data.id;
    };
    const withDisconnectAbort = async <T>(
      request: { raw: { socket: import('node:net').Socket } },
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const controller = new AbortController();
      const socket = request.raw.socket;
      const abortOnDisconnect = (): void => controller.abort();
      socket.once('close', abortOnDisconnect);
      try {
        return await run(controller.signal);
      } finally {
        socket.off('close', abortOnDisconnect);
      }
    };

    scoped.get('/capability-baseline', async () => service.getView());

    scoped.post('/capability-baseline/evidence/manual', async (request) => (
      service.createManualEvidence(request.body)
    ));
    scoped.post('/capability-baseline/evidence/generate', async (request) => (
      withDisconnectAbort(request, (signal) => service.generateEvidence(request.body, signal))
    ));
    scoped.post('/capability-baseline/evidence/:id/accept', async (request) => (
      service.acceptEvidence(idFrom(request.params), request.body)
    ));
    scoped.post('/capability-baseline/evidence/:id/reject', async (request) => (
      service.rejectEvidence(idFrom(request.params), request.body)
    ));
    scoped.post('/capability-baseline/evidence/:id/defer', async (request) => (
      service.deferEvidence(idFrom(request.params), request.body)
    ));

    scoped.post('/capability-baseline/proposals/manual', async (request) => (
      service.createManualBaselineProposal(request.body)
    ));
    scoped.post('/capability-baseline/proposals/generate', async (request) => (
      withDisconnectAbort(request, (signal) => service.generateBaselineProposal(request.body, signal))
    ));
    scoped.post('/capability-baseline/proposals/:id/accept', async (request) => (
      service.acceptBaselineProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/capability-baseline/proposals/:id/reject', async (request) => (
      service.rejectBaselineProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/capability-baseline/proposals/:id/defer', async (request) => (
      service.deferBaselineProposal(idFrom(request.params), request.body)
    ));

    scoped.post('/capability-baseline/versions/:id/activate', async (request) => (
      service.activateVersion(idFrom(request.params), request.body)
    ));
  });
}
