import type { FastifyInstance } from 'fastify';
import { ProfileRepository } from '../repositories/profileRepository';

export function registerProfileRoutes(app: FastifyInstance): void {
  const repo = new ProfileRepository(app.db);

  app.get('/profile', async () => repo.get());

  app.put('/profile', async (request) => repo.save(request.body as never));

  app.delete('/profile', async () => {
    repo.delete();
    return { ok: true };
  });
}
