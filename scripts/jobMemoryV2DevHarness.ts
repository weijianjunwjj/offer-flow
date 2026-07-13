import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  createServer as createViteServer,
  type InlineConfig,
  type ViteDevServer,
} from 'vite';
import {
  ResumeVersionListResponseSchema,
  ResumeVersionRecordSchema,
} from '../src/domain/job-memory';
import type { JobSeekerProfile } from '../src/storage';
import { openDb, type SqliteDatabase } from '../server/db';
import { buildServer } from '../server/index';
import { getDatabaseSchemaVersion } from '../server/migrations';
import { ProfileRepository } from '../server/repositories/profileRepository';
import { initSchema } from '../server/schema';

const DEV_HOST = '127.0.0.1';
const DEV_API_PORT = 17365;
const DEV_WEB_PORT = 5173;
const TEMP_PREFIX = 'offerflow-job-memory-v2-';

export const SYNTHETIC_DEV_PROFILE: JobSeekerProfile = Object.freeze({
  resumeText: '【B3 临时联调测试数据】6 年前端经验，熟悉 Vue 3 与 TypeScript。',
  projectExperience: '【B3 临时联调测试数据】OfferFlow：本地优先的 AI 求职机会决策台。',
  targetCity: '苏州（临时测试）',
  targetRole: '高级前端工程师（临时测试）',
  expectedSalary: '仅测试，不代表真实期望',
  acceptOutsourcing: false,
  acceptOvertime: false,
  jobSearchFocus: 'growth',
  weaknessNote: 'B3 临时联调合成 Profile；退出后随临时数据库删除。',
});

function isInsidePath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertSafeTemporaryDbPath(dbPath: string, tempDir: string): void {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedTempDir = path.resolve(tempDir);
  const defaultRealDbPath = path.resolve(process.cwd(), 'data', 'offerflow.sqlite3');
  const repositoryDataDir = path.resolve(process.cwd(), 'data');
  if (resolvedDbPath === defaultRealDbPath) {
    throw new Error('临时联调拒绝使用默认真实数据库路径');
  }
  if (resolvedDbPath === repositoryDataDir || isInsidePath(resolvedDbPath, repositoryDataDir)) {
    throw new Error('临时联调数据库不得位于仓库 data 目录');
  }
  if (!isInsidePath(resolvedDbPath, resolvedTempDir)) {
    throw new Error('临时联调数据库必须位于本次新建的系统临时目录');
  }
  if (fs.existsSync(resolvedDbPath)) {
    throw new Error('临时联调数据库文件必须是本次新建，拒绝复用已有文件');
  }
}

export interface TemporaryJobMemoryWorkspace {
  readonly tempDir: string;
  readonly dbPath: string;
  readonly db: SqliteDatabase;
  close(): void;
}

export function createTemporaryJobMemoryWorkspace(): TemporaryJobMemoryWorkspace {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const dbPath = path.join(tempDir, 'offerflow-job-memory-v2.sqlite3');
  let db: SqliteDatabase | null = null;
  let closed = false;
  try {
    assertSafeTemporaryDbPath(dbPath, tempDir);
    db = openDb(dbPath);
    initSchema(db, { targetVersion: 2 });
    if (getDatabaseSchemaVersion(db) !== 2) {
      throw new Error('临时联调数据库未初始化到 schema v2');
    }
    new ProfileRepository(db).save({ ...SYNTHETIC_DEV_PROFILE });
    const openedDb = db;
    return {
      tempDir,
      dbPath,
      db: openedDb,
      close() {
        if (closed) return;
        closed = true;
        openedDb.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function jobMemoryV2ViteConfig(): InlineConfig {
  return {
    configFile: path.resolve('vite.config.ts'),
    envFile: false,
    define: {
      'import.meta.env.VITE_OFFERFLOW_RESUME_VERSION_MANAGEMENT': JSON.stringify('true'),
    },
    server: {
      host: DEV_HOST,
      port: DEV_WEB_PORT,
      strictPort: true,
    },
  };
}

export function hasExplicitFrontendResumeVersionFlag(config: InlineConfig): boolean {
  return config.define?.['import.meta.env.VITE_OFFERFLOW_RESUME_VERSION_MANAGEMENT']
    === JSON.stringify('true');
}

export interface JobMemoryV2DevSession {
  readonly tempDir: string;
  readonly dbPath: string;
  readonly apiUrl: string;
  readonly webUrl: string | null;
  close(): Promise<void>;
}

export interface StartSessionOptions {
  withVite: boolean;
  apiPort?: number;
  viteFactory?: (config: InlineConfig) => Promise<ViteDevServer>;
}

export async function startJobMemoryV2DevSession(
  options: StartSessionOptions,
): Promise<JobMemoryV2DevSession> {
  const workspace = createTemporaryJobMemoryWorkspace();
  let app: FastifyInstance | null = null;
  let vite: ViteDevServer | null = null;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const closeErrors: unknown[] = [];
    if (vite !== null) {
      try {
        await vite.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (app !== null) {
      try {
        await app.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
    try {
      workspace.close();
    } catch (error) {
      closeErrors.push(error);
    }
    if (closeErrors.length > 0) {
      throw new Error(`临时联调资源清理失败（${closeErrors.length} 项）`);
    }
  };

  try {
    const builtApp = buildServer({
      db: workspace.db,
      jobMemoryV2: { enabled: true },
    });
    app = builtApp;
    const apiUrl = await builtApp.listen({
      host: DEV_HOST,
      port: options.apiPort ?? DEV_API_PORT,
    });
    let webUrl: string | null = null;
    if (options.withVite) {
      const viteFactory = options.viteFactory ?? createViteServer;
      vite = await viteFactory(jobMemoryV2ViteConfig());
      await vite.listen();
      webUrl = `http://${DEV_HOST}:${DEV_WEB_PORT}`;
    }
    return {
      tempDir: workspace.tempDir,
      dbPath: workspace.dbPath,
      apiUrl,
      webUrl,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`临时联调 smoke HTTP ${response.status}`);
  }
  return body;
}

export interface JobMemoryV2SmokeReport {
  schemaVersion: 2;
  routeEnabled: true;
  frontendFlagEnabled: true;
  injectedDbOnly: true;
  syntheticProfileOnly: true;
  createdResumeVersionId: string;
  tempDirRemoved: true;
}

export async function runJobMemoryV2Smoke(): Promise<JobMemoryV2SmokeReport> {
  const session = await startJobMemoryV2DevSession({ withVite: false, apiPort: 0 });
  const tempDir = session.tempDir;
  let createdResumeVersionId = '';
  try {
    const metadata = await fetchJson(`${session.apiUrl}/meta/db-path`);
    if (
      metadata === null
      || typeof metadata !== 'object'
      || !('path' in metadata)
      || metadata.path !== ':injected:'
    ) {
      throw new Error('临时联调 Server 未使用注入数据库');
    }
    const listBefore = ResumeVersionListResponseSchema.parse(
      await fetchJson(`${session.apiUrl}/resume-versions`),
    );
    if (listBefore.resumeVersions.length !== 0) {
      throw new Error('临时联调数据库不应预置简历版本');
    }
    const created = ResumeVersionRecordSchema.parse(await fetchJson(
      `${session.apiUrl}/resume-versions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotencyKey: 'b3-smoke-resume-version',
          name: 'B3 临时联调简历',
          source: 'profile_snapshot',
          summary: '仅用于验证临时 v2 路由，退出即删除',
          contentSnapshot: {
            resumeText: SYNTHETIC_DEV_PROFILE.resumeText,
            projectExperience: SYNTHETIC_DEV_PROFILE.projectExperience,
          },
        }),
      },
    ));
    createdResumeVersionId = created.id;
    const listAfter = ResumeVersionListResponseSchema.parse(
      await fetchJson(`${session.apiUrl}/resume-versions`),
    );
    if (listAfter.resumeVersions.length !== 1 || listAfter.resumeVersions[0]?.id !== created.id) {
      throw new Error('临时联调 ResumeVersion 创建后未能稳定读回');
    }
    if (!hasExplicitFrontendResumeVersionFlag(jobMemoryV2ViteConfig())) {
      throw new Error('临时联调入口未显式开启前端 ResumeVersion flag');
    }
  } finally {
    await session.close();
  }
  if (fs.existsSync(tempDir)) {
    throw new Error('临时联调退出后仍残留 SQLite 临时目录');
  }
  return {
    schemaVersion: 2,
    routeEnabled: true,
    frontendFlagEnabled: true,
    injectedDbOnly: true,
    syntheticProfileOnly: true,
    createdResumeVersionId,
    tempDirRemoved: true,
  };
}

type ShutdownTarget = Pick<NodeJS.Process, 'once' | 'removeListener'>;

export interface ShutdownController {
  wait(): Promise<number>;
  requestShutdown(exitCode: number, error?: unknown): Promise<void>;
  dispose(): void;
}

export function createShutdownController(
  target: ShutdownTarget,
  cleanup: () => Promise<void>,
  reportError: (error: unknown) => void = console.error,
): ShutdownController {
  let resolveExit!: (exitCode: number) => void;
  const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve; });
  let shutdownPromise: Promise<void> | null = null;

  const requestShutdown = (exitCode: number, error?: unknown): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    if (error !== undefined) reportError(error);
    shutdownPromise = cleanup()
      .then(() => resolveExit(exitCode))
      .catch((cleanupError: unknown) => {
        reportError(cleanupError);
        resolveExit(1);
      });
    return shutdownPromise;
  };
  const onSigint = (): void => { void requestShutdown(130); };
  const onSigterm = (): void => { void requestShutdown(143); };
  const onUncaughtException = (error: Error): void => { void requestShutdown(1, error); };
  const onUnhandledRejection = (reason: unknown): void => { void requestShutdown(1, reason); };
  target.once('SIGINT', onSigint);
  target.once('SIGTERM', onSigterm);
  target.once('uncaughtException', onUncaughtException);
  target.once('unhandledRejection', onUnhandledRejection);

  return {
    wait: () => exitPromise,
    requestShutdown,
    dispose() {
      target.removeListener('SIGINT', onSigint);
      target.removeListener('SIGTERM', onSigterm);
      target.removeListener('uncaughtException', onUncaughtException);
      target.removeListener('unhandledRejection', onUnhandledRejection);
    },
  };
}
