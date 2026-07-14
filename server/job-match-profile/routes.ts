import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { JobMatchProfileServiceDeps } from './service';
import { JobMatchProfileService } from './service';
import { JobMatchProfileError, invalidProposal } from './errors';

const paramsSchema = z.strictObject({ id: z.string().trim().min(1).max(200) });

export function registerJobMatchProfileRoutes(
  app: FastifyInstance,
  deps: JobMatchProfileServiceDeps = {},
): void {
  app.register(async (scoped) => {
    const service = new JobMatchProfileService(scoped.db, deps);
    scoped.setErrorHandler((error, _request, reply) => {
      if (error instanceof JobMatchProfileError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      return reply.code(500).send({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
    });
    const idFrom = (input: unknown): string => {
      const result = paramsSchema.safeParse(input);
      if (!result.success) throw invalidProposal(result.error);
      return result.data.id;
    };

    scoped.get('/job-match-profile', async () => service.getProfile());
    scoped.post('/job-match-profile/proposals/generate', async (request) => {
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
    scoped.post('/job-match-profile/proposals/manual', async (request) => (
      service.createManualProposal(request.body)
    ));
    scoped.post('/job-match-profile/proposals/:id/accept', async (request) => (
      service.acceptProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/job-match-profile/proposals/:id/reject', async (request) => (
      service.rejectProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/job-match-profile/proposals/:id/defer', async (request) => (
      service.deferProposal(idFrom(request.params), request.body)
    ));
    scoped.post('/job-match-profile/versions/:id/activate', async (request) => (
      service.activateVersion(idFrom(request.params), request.body)
    ));
  });
}
