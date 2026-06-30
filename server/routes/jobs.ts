import type { FastifyInstance } from 'fastify';
import { JobRepository } from '../repositories/jobRepository';

export function registerJobRoutes(app: FastifyInstance): void {
  const repo = new JobRepository(app.db);

  app.get('/jobs', async () => repo.list());

  app.post('/jobs', async (request) => repo.create(request.body as never));

  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = repo.get(id);
    if (job === null) {
      return reply.code(404).send({ error: 'job not found' });
    }
    return job;
  });

  app.put('/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return repo.replace(id, request.body as never);
  });

  app.patch('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = repo.patch(id, request.body as never);
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
