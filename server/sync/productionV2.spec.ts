import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { features, readBooleanFeatureFlag } from '../../src/config/features';
import { openDb } from '../db';
import { buildServer } from '../index';
import { getDatabaseSchemaVersion, PRODUCTION_SCHEMA_VERSION } from '../migrations';
import { initSchema } from '../schema';
import { exportSnapshotToDirectory, publishSnapshotPairAtomically } from './exportSnapshot';
import { sha256Hex, toStableJson } from './hash';
import { SNAPSHOT_SCHEMA_VERSION, SYNC_TABLES } from './types';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function temp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writePair(directory: string, marker: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const snapshot = toStableJson({ marker });
  fs.writeFileSync(path.join(directory, 'offerflow.snapshot.json'), snapshot, 'utf8');
  fs.writeFileSync(path.join(directory, 'offerflow.manifest.json'), toStableJson({
    snapshotHash: sha256Hex(snapshot),
  }), 'utf8');
}

describe('B7-B 生产默认 v2', () => {
  it('新数据库默认 schema=2、Server capability=true 且 v2 routes 可用', async () => {
    const directory = temp('offerflow-production-v2-server-');
    const dbPath = path.join(directory, 'offerflow.sqlite3');
    const app = buildServer(dbPath);
    cleanups.push(() => app.close());
    expect(PRODUCTION_SCHEMA_VERSION).toBe(2);
    expect(getDatabaseSchemaVersion(app.db)).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/resume-versions' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/jobs/summaries' })).statusCode).toBe(200);
  });

  it('显式 capability=false 保留 v1 adapter，schema1 不会被普通 Server 悄悄迁移', async () => {
    const directory = temp('offerflow-production-v1-compat-');
    const dbPath = path.join(directory, 'offerflow.sqlite3');
    const app = buildServer({ dbPath, jobMemoryV2: { enabled: false } });
    cleanups.push(() => app.close());
    expect(getDatabaseSchemaVersion(app.db)).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/resume-versions' })).statusCode).toBe(404);
  });

  it('默认 capability 遇到已有 schema1 时拒绝启动且不创建 v2 表', () => {
    const directory = temp('offerflow-production-v1-reject-');
    const dbPath = path.join(directory, 'offerflow.sqlite3');
    const db = openDb(dbPath);
    initSchema(db, { targetVersion: 1 });
    db.close();
    expect(() => buildServer(dbPath)).toThrow(/authorized B7-B upgrade tool/);
    const verify = openDb(dbPath);
    try {
      expect(getDatabaseSchemaVersion(verify)).toBe(1);
      expect(verify.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name='applications'",
      ).get()).toEqual({ count: 0 });
    } finally {
      verify.close();
    }
  });

  it('前端默认 flag=true，仍可显式 false', () => {
    expect(features.jobMemoryV2Enabled).toBe(true);
    expect(readBooleanFeatureFlag(undefined, true)).toBe(true);
    expect(readBooleanFeatureFlag('false', true)).toBe(false);
  });
});

describe('B7-B 正式 Snapshot v2 发布', () => {
  it('默认 snapshot schema=2 并同步三张新表', () => {
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(2);
    expect(SYNC_TABLES).toContain('resume_versions');
    expect(SYNC_TABLES).toContain('applications');
    expect(SYNC_TABLES).toContain('feedback_events');
    const directory = temp('offerflow-production-v2-snapshot-');
    const dbPath = path.join(directory, 'offerflow.sqlite3');
    const snapshotDirectory = path.join(directory, 'snapshot');
    const db = openDb(dbPath);
    initSchema(db, { targetVersion: 2 });
    db.close();
    const result = exportSnapshotToDirectory(dbPath, snapshotDirectory, 'fixture-device');
    expect(result.tableCounts).toMatchObject({
      resume_versions: 0, applications: 0, feedback_events: 0,
    });
    const snapshot = JSON.parse(fs.readFileSync(result.snapshotPath, 'utf8')) as {
      schemaVersion: number;
      databaseSchemaVersion: number;
    };
    expect(snapshot).toMatchObject({ schemaVersion: 2, databaseSchemaVersion: 2 });
  });

  it('manifest 发布中途失败时恢复完整旧 pair，不留下 rollback/tmp', () => {
    const directory = temp('offerflow-production-v2-publish-');
    const target = path.join(directory, 'target');
    const staging = path.join(directory, 'staging');
    writePair(target, 'old');
    writePair(staging, 'new');
    const oldSnapshot = fs.readFileSync(path.join(target, 'offerflow.snapshot.json'), 'utf8');
    const oldManifest = fs.readFileSync(path.join(target, 'offerflow.manifest.json'), 'utf8');
    expect(() => publishSnapshotPairAtomically(staging, target, {
      failAfterSnapshotReplace: true,
    })).toThrow('B7B_TEST_SNAPSHOT_PUBLISH_FAILURE');
    expect(fs.readFileSync(path.join(target, 'offerflow.snapshot.json'), 'utf8')).toBe(oldSnapshot);
    expect(fs.readFileSync(path.join(target, 'offerflow.manifest.json'), 'utf8')).toBe(oldManifest);
    expect(fs.readdirSync(target).some((name) => name.includes('.rollback.tmp'))).toBe(false);
  });
});
