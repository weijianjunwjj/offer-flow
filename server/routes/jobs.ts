import type { FastifyInstance } from 'fastify';
import { JobRepository } from '../repositories/jobRepository';
import { LegacyCommunicationWriteError } from '../repositories/legacyCommunicationGuard';

export interface JobRouteOptions {
  legacyCommunicationWriteDisabled?: boolean;
}

function sendWriteError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof LegacyCommunicationWriteError) {
    return reply.code(error.statusCode).send(error.toBody());
  }
  throw error;
}

export function registerJobRoutes(app: FastifyInstance, options: JobRouteOptions = {}): void {
  const repo = new JobRepository(app.db, options);

  app.get('/jobs', async () => repo.list());

  app.post('/jobs', async (request, reply) => {
    try {
      return repo.create(request.body as never);
    } catch (error) {
      return sendWriteError(reply, error);
    }
  });

  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = repo.get(id);
    if (job === null) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return job;
  });

  app.put('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return repo.replace(id, request.body as never);
    } catch (error) {
      return sendWriteError(reply, error);
    }
  });

  app.patch('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    let job;
    try {
      job = repo.patch(id, request.body as never);
    } catch (error) {
      return sendWriteError(reply, error);
    }
    if (job === null) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return job;
  });

  app.delete('/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    repo.delete(id);
    return { ok: true };
  });
}
