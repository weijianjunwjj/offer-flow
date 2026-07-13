import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeTemporaryDbPath,
  createShutdownController,
  createTemporaryJobMemoryWorkspace,
  hasExplicitFrontendJobMemoryV2Flag,
  jobMemoryV2ViteConfig,
  runJobMemoryV2Smoke,
  startJobMemoryV2DevSession,
  SYNTHETIC_DEV_PROFILE,
  SYNTHETIC_DEV_JOB_IDS,
} from '../../scripts/jobMemoryV2DevHarness';
import { getDatabaseSchemaVersion } from '../migrations';
import { ProfileRepository } from '../repositories/profileRepository';
import { JobRepository } from '../repositories/jobRepository';
import { JobMemoryQueries } from './jobMemoryQueries';

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target !== undefined) fs.rmSync(target, { recursive: true, force: true });
  }
});

function tempHarnessPath(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b3-harness-test-'));
  cleanupPaths.push(tempDir);
  return { tempDir, dbPath: path.join(tempDir, 'test.sqlite3') };
}

function currentHarnessDirs(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('offerflow-job-memory-v2-')));
}

describe('B4 临时 v2 联调安全门禁', () => {
  it('拒绝默认真实库、仓库 data、临时目录外和已有文件', () => {
    const { tempDir, dbPath } = tempHarnessPath();
    expect(() => assertSafeTemporaryDbPath(
      path.resolve('data', 'offerflow.sqlite3'),
      tempDir,
    )).toThrow(/默认真实数据库路径/);
    expect(() => assertSafeTemporaryDbPath(
      path.resolve('data', 'b3-test.sqlite3'),
      tempDir,
    )).toThrow(/仓库 data 目录/);
    expect(() => assertSafeTemporaryDbPath(path.resolve('outside.sqlite3'), tempDir))
      .toThrow(/本次新建的系统临时目录/);
    fs.writeFileSync(dbPath, 'existing');
    expect(() => assertSafeTemporaryDbPath(dbPath, tempDir)).toThrow(/拒绝复用已有文件/);
  });

  it('只在新临时库初始化 schema v2、合成 Profile、两岗位与两简历，且不预置 Application', () => {
    const workspace = createTemporaryJobMemoryWorkspace();
    const { tempDir, dbPath, db } = workspace;
    expect(tempDir.startsWith(os.tmpdir())).toBe(true);
    expect(dbPath.startsWith(tempDir)).toBe(true);
    expect(getDatabaseSchemaVersion(db)).toBe(2);
    expect(new ProfileRepository(db).get()).toEqual(SYNTHETIC_DEV_PROFILE);
    expect(new JobRepository(db).list().map(({ id }) => id).sort()).toEqual([...SYNTHETIC_DEV_JOB_IDS].sort());
    const queries = new JobMemoryQueries(db);
    expect(queries.listResumeVersions().resumeVersions).toHaveLength(2);
    expect(queries.getJobMemoryBundle(SYNTHETIC_DEV_JOB_IDS[0]).applications).toHaveLength(0);
    workspace.close();
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it('前端 flag 由专用 Vite 配置显式开启，而不是修改默认源码常量', () => {
    const config = jobMemoryV2ViteConfig();
    expect(config.envFile).toBe(false);
    expect(hasExplicitFrontendJobMemoryV2Flag(config)).toBe(true);
    expect(config.server).toMatchObject({ host: '127.0.0.1', strictPort: true });
  });

  it('Vite 启动失败会关闭 Fastify、SQLite 并清理临时目录', async () => {
    const before = currentHarnessDirs();
    await expect(startJobMemoryV2DevSession({
      withVite: true,
      apiPort: 0,
      viteFactory: vi.fn().mockRejectedValue(new Error('vite failed')),
    })).rejects.toThrow('vite failed');
    const after = currentHarnessDirs();
    expect(after).toEqual(before);
  });

  it('Fastify 端口启动失败也会清理临时 SQLite', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    if (address === null || typeof address === 'string') throw new Error('未取得测试端口');
    const before = currentHarnessDirs();
    try {
      await expect(startJobMemoryV2DevSession({
        withVite: false,
        apiPort: address.port,
      })).rejects.toThrow();
      expect(currentHarnessDirs()).toEqual(before);
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => (
        error === undefined ? resolve() : reject(error)
      )));
    }
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s 触发一次幂等清理并返回对应退出码', async (signal, expectedCode) => {
    const events = new EventEmitter();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const controller = createShutdownController(
      events as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
      cleanup,
    );
    events.emit(signal);
    expect(await controller.wait()).toBe(expectedCode);
    events.emit(signal);
    await controller.requestShutdown(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('uncaughtException 会清理并以 1 结束，不残留服务资源', async () => {
    const events = new EventEmitter();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const reportError = vi.fn();
    const controller = createShutdownController(
      events as unknown as Pick<NodeJS.Process, 'once' | 'removeListener'>,
      cleanup,
      reportError,
    );
    const failure = new Error('boom');
    events.emit('uncaughtException', failure);
    expect(await controller.wait()).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(failure);
    controller.dispose();
  });

  it('smoke 通过 HTTP 创建两次 Application 并读回 Bundle/摘要，退出后清理', async () => {
    await expect(runJobMemoryV2Smoke()).resolves.toMatchObject({
      schemaVersion: 2,
      routeEnabled: true,
      frontendFlagEnabled: true,
      injectedDbOnly: true,
      syntheticProfileOnly: true,
      createdApplicationCount: 2,
      jobSummaryCount: 2,
      tempDirRemoved: true,
    });
  });
});
