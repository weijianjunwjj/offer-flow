import type { FastifyInstance } from 'fastify';
import { applyLocalStorageBackup, parseLocalStorageBackup } from '../importLocalStorage';

export function registerImportRoutes(app: FastifyInstance): void {
  app.post('/imports/localstorage/preview', async (request) => {
    return parseLocalStorageBackup(request.body).summary;
  });

  app.post('/imports/localstorage/apply', async (request) => {
    return applyLocalStorageBackup(app.db, request.body);
  });
}
