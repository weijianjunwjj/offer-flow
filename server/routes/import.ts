import type { FastifyInstance } from 'fastify';
import { applyLocalStorageBackup, parseLocalStorageBackup } from '../importLocalStorage';
import { LegacyCommunicationWriteError } from '../repositories/legacyCommunicationGuard';

export interface ImportRouteOptions {
  legacyCommunicationWriteDisabled?: boolean;
}

export function registerImportRoutes(app: FastifyInstance, options: ImportRouteOptions = {}): void {
  app.post('/imports/localstorage/preview', async (request) => {
    return parseLocalStorageBackup(request.body).summary;
  });

  app.post('/imports/localstorage/apply', async (request, reply) => {
    try {
      return applyLocalStorageBackup(app.db, request.body, 'localstorage-json', options);
    } catch (error) {
      if (error instanceof LegacyCommunicationWriteError) {
        return reply.code(error.statusCode).send(error.toBody());
      }
      throw error;
    }
  });
}
