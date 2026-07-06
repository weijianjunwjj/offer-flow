import type { FastifyInstance } from 'fastify';
import { backupDatabase } from '../sync/backup';
import { doctorDatabase } from '../sync/doctor';
import { exportSnapshot } from '../sync/exportSnapshot';
import { importSnapshot } from '../sync/importSnapshot';
import { runSync } from '../sync/syncRunner';
import { getSyncStatus } from '../sync/status';

export function registerSyncRoutes(app: FastifyInstance, dbPath?: string): void {
  app.get('/api/sync/status', async () => getSyncStatus(dbPath));

  app.post('/api/sync/doctor', async () => doctorDatabase(dbPath));

  app.post('/api/sync/export', async () => exportSnapshot(dbPath));

  app.post('/api/sync/import', async () => importSnapshot(dbPath));

  app.post('/api/sync/run', async () => runSync(dbPath));

  app.post('/api/sync/backup', async () => backupDatabase(dbPath));
}
