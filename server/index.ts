import { loadProjectEnv } from './config/loadEnv';
loadProjectEnv();

import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { getDbPath, openDb, type SqliteDatabase } from './db';
import type { JobMemoryServiceDeps } from './job-memory/jobMemoryService';
import type { JobMatchProfileServiceDeps } from './job-match-profile/service';
import type { CapabilityBaselineServiceDeps } from './capability-baseline/service';
import { registerJobMatchProfileRoutes } from './job-match-profile/routes';
import { registerCapabilityBaselineRoutes } from './capability-baseline/routes';
import { registerJobMemoryRoutes } from './job-memory/routes';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
} from './migrations';
import { initSchema } from './schema';
import { registerProfileRoutes } from './routes/profile';
import { registerJobRoutes } from './routes/jobs';
import { registerImportRoutes } from './routes/import';
import { registerSyncRoutes } from './routes/sync';
import { registerLlmRoutes } from './routes/llm';
import { createShutdownSnapshotExporter, runStartupSync } from './sync/bootstrap';

declare module 'fastify' {
  interface FastifyInstance {
    db: SqliteDatabase;
  }
}

export interface JobMemoryV2Capability {
  enabled: boolean;
  serviceDeps?: JobMemoryServiceDeps;
}

export interface CapabilityBaselineCapability {
  enabled?: boolean;
  serviceDeps?: CapabilityBaselineServiceDeps;
}

export interface BuildServerOptions {
  dbPath?: string;
  db?: SqliteDatabase;
  jobMemoryV2?: JobMemoryV2Capability;
  jobMatchProfile?: JobMatchProfileServiceDeps;
  capabilityBaseline?: CapabilityBaselineCapability;
}

function normalizeBuildOptions(input: string | BuildServerOptions): BuildServerOptions {
  return typeof input === 'string' ? { dbPath: input } : input;
}

export function buildServer(
  input: string | BuildServerOptions = {},
): ReturnType<typeof Fastify> {
  const options = normalizeBuildOptions(input);
  const dbPath = options.dbPath ?? (options.db === undefined ? getDbPath() : ':injected:');
  const jobMemoryV2 = options.jobMemoryV2 ?? { enabled: true };
  const capabilityBaselineEnabled = options.capabilityBaseline?.enabled ?? true;
  const shouldRunLifecycleSync = options.db === undefined && dbPath === getDbPath();
  if (shouldRunLifecycleSync) {
    const bootstrap = runStartupSync(dbPath);
    if (bootstrap.warnings.length > 0) {
      console.warn('[sync] startup warnings:', bootstrap.warnings.join('; '));
    }
  }

  const app = Fastify({ logger: false });
  const db = options.db ?? openDb(dbPath);
  const ownsDb = options.db === undefined;
  if (jobMemoryV2.enabled) {
    const targetVersion = capabilityBaselineEnabled ? LATEST_SCHEMA_VERSION : PRODUCTION_SCHEMA_VERSION;
    let schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion === 0) {
      initSchema(db, { targetVersion });
      schemaVersion = getDatabaseSchemaVersion(db);
    } else if (
      capabilityBaselineEnabled
      && schemaVersion >= PRODUCTION_SCHEMA_VERSION
      && schemaVersion < LATEST_SCHEMA_VERSION
    ) {
      // 纯新增的 G2 能力基线表；v2 生产语义不受影响。
      initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION });
      schemaVersion = getDatabaseSchemaVersion(db);
    }
    if (schemaVersion < PRODUCTION_SCHEMA_VERSION) {
      if (ownsDb) db.close();
      throw new Error(
        `Job Memory v2 capability requires schema version 2; current version is ${schemaVersion}. `
        + 'Legacy schema v1 must use the authorized B7-B upgrade tool.',
      );
    }
  } else {
    const schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion === 0) initSchema(db, { targetVersion: 1 });
  }
  app.decorate('db', db);
  const exportOnClose = createShutdownSnapshotExporter(dbPath);

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
    if (shouldRunLifecycleSync) {
      exportOnClose();
    }
  });

  app.addHook('onClose', async () => {
    if (ownsDb) db.close();
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/meta/db-path', async () => ({ path: dbPath }));
  registerProfileRoutes(app);
  const legacyCommunicationWriteDisabled = jobMemoryV2.enabled;
  registerJobRoutes(app, { legacyCommunicationWriteDisabled });
  registerImportRoutes(app, { legacyCommunicationWriteDisabled });
  registerSyncRoutes(app, dbPath);
  registerLlmRoutes(app);
  if (jobMemoryV2.enabled) {
    registerJobMemoryRoutes(app, { serviceDeps: jobMemoryV2.serviceDeps });
    registerJobMatchProfileRoutes(app, options.jobMatchProfile);
    if (capabilityBaselineEnabled) {
      registerCapabilityBaselineRoutes(app, options.capabilityBaseline?.serviceDeps);
    }
  }
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildServer();
  let isClosing = false;
  const closeAndExit = (signal: NodeJS.Signals): void => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    app
      .close()
      .then(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => closeAndExit('SIGINT'));
  process.once('SIGTERM', () => closeAndExit('SIGTERM'));
  app.listen({ host: '127.0.0.1', port: 17365 }).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
