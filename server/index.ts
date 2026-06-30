import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { getDbPath, openDb, type SqliteDatabase } from './db';
import { initSchema } from './schema';
import { registerProfileRoutes } from './routes/profile';
import { registerJobRoutes } from './routes/jobs';
import { registerImportRoutes } from './routes/import';

declare module 'fastify' {
  interface FastifyInstance {
    db: SqliteDatabase;
  }
}

export function buildServer(dbPath = getDbPath()): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  const db = openDb(dbPath);
  initSchema(db);
  app.decorate('db', db);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'content-type');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
    return undefined;
  });

  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/meta/db-path', async () => ({ path: dbPath }));
  registerProfileRoutes(app);
  registerJobRoutes(app);
  registerImportRoutes(app);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildServer();
  app.listen({ host: '127.0.0.1', port: 17365 }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
