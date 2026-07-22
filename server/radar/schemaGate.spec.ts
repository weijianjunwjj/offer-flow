import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db';
import { buildServer } from '../index';
import { getDatabaseSchemaVersion } from '../migrations';
import { initSchema } from '../schema';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function makeTempPath(prefix: string): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { tempDir, dbPath: path.join(tempDir, 'test.sqlite3') };
}

describe('Radar capability gate (V8-2)', () => {
  it('radar 关闭时，v6 库正常启动且不注册雷达路由', async () => {
    const { tempDir, dbPath } = makeTempPath('offerflow-radar-off-v6-');
    const db = openDb(dbPath);
    initSchema(db, { targetVersion: 6 });
    db.close();
    const app = buildServer({
      dbPath,
      jobMemoryV2: { enabled: true },
      strategyWindow: { enabled: true },
    });
    cleanups.push(async () => {
      await app.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    expect(getDatabaseSchemaVersion(app.db)).toBe(6);
    const response = await app.inject({ method: 'POST', url: '/radar/capture-sessions' });
    expect(response.statusCode).toBe(404);
  });

  it('radar 开启但真实库仍是 v6 时，服务拒绝启动并给出明确升级提示', () => {
    const { tempDir, dbPath } = makeTempPath('offerflow-radar-on-v6-refuse-');
    const db = openDb(dbPath);
    initSchema(db, { targetVersion: 6 });
    db.close();
    const previousDbPath = process.env.OFFERFLOW_DB_PATH;
    process.env.OFFERFLOW_DB_PATH = dbPath;
    cleanups.push(() => {
      if (previousDbPath === undefined) delete process.env.OFFERFLOW_DB_PATH;
      else process.env.OFFERFLOW_DB_PATH = previousDbPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    // 不传 dbPath：走真实生产库路径（isRealProductionDb=true），禁止自动迁移。
    expect(() => buildServer({
      jobMemoryV2: { enabled: true },
      radar: { enabled: true },
    })).toThrow(/schema 版本为 6.*应用所需的 7/);
  });

  it('radar 开启且注入库已是 v7 时，雷达路由可用', async () => {
    const { tempDir } = makeTempPath('offerflow-radar-on-v7-');
    const db = openDb(path.join(tempDir, 'injected.sqlite3'));
    initSchema(db, { targetVersion: 7 });
    const app = buildServer({
      db,
      jobMemoryV2: { enabled: true },
      radar: { enabled: true },
    });
    cleanups.push(async () => {
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
    const created = await app.inject({
      method: 'POST',
      url: '/radar/capture-sessions',
      headers: { 'x-offerflow-capture-client': 'test' },
      payload: { sourceType: 'browser' },
    });
    expect(created.statusCode).toBe(200);
  });
});
