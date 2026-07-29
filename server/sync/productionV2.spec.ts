import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { features, readBooleanFeatureFlag } from '../../src/config/features';
import { openDb } from '../db';
import { buildServer } from '../index';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
} from '../migrations';
import { JobRepository } from '../repositories/jobRepository';
import { initSchema } from '../schema';
import { auditSnapshotConsistency } from './consistency';
import { exportSnapshotToDirectory, publishSnapshotPairAtomically } from './exportSnapshot';
import { sha256Hex, toStableJson } from './hash';
import { SNAPSHOT_SCHEMA_VERSION, SYNC_TABLES } from './types';
import { assertOfficialSnapshotCountsMatchStaging } from '../job-memory/upgrade/officialSnapshot';

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

  it('staging 比较只允许正式库新增 apply marker 导致的 app_meta 差异', () => {
    const expected = {
      profiles: 1, jobs: 13, resume_versions: 0, applications: 7,
      feedback_events: 7, import_logs: 2, app_meta: 1,
    };
    expect(() => assertOfficialSnapshotCountsMatchStaging(expected, {
      ...expected, app_meta: 2,
    })).not.toThrow();
    expect(() => assertOfficialSnapshotCountsMatchStaging(expected, {
      ...expected, applications: 8, app_meta: 2,
    })).toThrow('applications');
  });
});

describe('增量架构核心业务 Snapshot 导出（v2 底座 + 纯增量升级）', () => {
  function seedAndExport(targetVersion: number): {
    dbPath: string;
    snapshotDirectory: string;
  } {
    const directory = temp(`offerflow-export-v${targetVersion}-`);
    const dbPath = path.join(directory, 'offerflow.sqlite3');
    const snapshotDirectory = path.join(directory, 'snapshot');
    const db = openDb(dbPath);
    try {
      initSchema(db, { targetVersion });
      const jobs = new JobRepository(db);
      jobs.create({ id: `v${targetVersion}-job-a`, company: `合成公司-${targetVersion}-A` });
      jobs.create({ id: `v${targetVersion}-job-b`, company: `合成公司-${targetVersion}-B` });
    } finally {
      db.close();
    }
    exportSnapshotToDirectory(dbPath, snapshotDirectory, `fixture-device-v${targetVersion}`);
    return { dbPath, snapshotDirectory };
  }

  it('v2/v7/v8 均导出非占位 pair：可读、哈希正确、核心记录一致且不含 Radar 表', () => {
    for (const version of [2, 7, 8]) {
      const { dbPath, snapshotDirectory } = seedAndExport(version);
      const snapshotText = fs.readFileSync(path.join(snapshotDirectory, 'offerflow.snapshot.json'), 'utf8');
      const manifestText = fs.readFileSync(path.join(snapshotDirectory, 'offerflow.manifest.json'), 'utf8');
      const snapshot = JSON.parse(snapshotText) as {
        schemaVersion: number;
        databaseSchemaVersion: number;
        tables: Record<string, { rows: Array<Record<string, unknown>> }>;
      };
      const manifest = JSON.parse(manifestText) as { schemaVersion: number; snapshotHash: string };
      // 快照文件格式恒为 v2；databaseSchemaVersion 描述被捕获的核心数据模型，仍为 v2。
      expect(snapshot).toMatchObject({ schemaVersion: 2, databaseSchemaVersion: 2 });
      expect(manifest.schemaVersion).toBe(2);
      // 非占位：真实核心表齐全，jobs 落地两条种子记录。
      expect(Object.keys(snapshot.tables).sort()).toEqual([...SYNC_TABLES].sort());
      expect(snapshot.tables.jobs?.rows).toHaveLength(2);
      // 只含核心业务表，绝不导出 Radar/能力等扩展表。
      expect(Object.keys(snapshot.tables)).not.toContain('radar_candidates');
      expect(Object.keys(snapshot.tables)).not.toContain('radar_actions');
      // manifest 哈希与 snapshot 正文一致，且核心记录与源库逐行一致（差异 0）。
      expect(manifest.snapshotHash).toBe(sha256Hex(snapshotText));
      const report = auditSnapshotConsistency(dbPath, snapshotDirectory);
      expect(report.ok).toBe(true);
    }
  });

  it('v2 导出行为不回归：仍产出 schema=2 且核心表齐全的 pair', () => {
    const { dbPath, snapshotDirectory } = seedAndExport(2);
    const report = auditSnapshotConsistency(dbPath, snapshotDirectory);
    expect(report.ok).toBe(true);
    expect(report.snapshotSchemaVersion).toBe(2);
  });

  it('导出仍拒绝未知未来版本、缺号、篡改、app_meta 不一致与核心结构损坏', () => {
    const cases: Array<{
      name: string;
      version: number;
      mutate: (db: ReturnType<typeof openDb>) => void;
      expected: RegExp | string;
    }> = [
      {
        name: '未知未来版本 v9',
        version: LATEST_SCHEMA_VERSION,
        mutate: (db) => {
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
            .run(LATEST_SCHEMA_VERSION + 1, '999_unknown_future', 1);
          db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'")
            .run(String(LATEST_SCHEMA_VERSION + 1));
        },
        expected: /newer than this application supports/u,
      },
      {
        name: 'migration 缺号',
        version: 7,
        mutate: (db) => { db.prepare('DELETE FROM schema_migrations WHERE version = 5').run(); },
        expected: /version gap or out-of-order/u,
      },
      {
        name: 'migration 名称被篡改',
        version: 7,
        mutate: (db) => {
          db.prepare('UPDATE schema_migrations SET name = ? WHERE version = 5').run('005_tampered');
        },
        expected: /name conflict/u,
      },
      {
        name: 'app_meta 不一致',
        version: 7,
        mutate: (db) => {
          db.prepare("UPDATE app_meta SET value = '6' WHERE key = 'schema_version'").run();
        },
        expected: 'app_meta schema_version 与 migration 不一致',
      },
      {
        name: '核心结构损坏',
        version: 2,
        mutate: (db) => { db.exec('DROP TABLE import_logs'); },
        expected: '缺少 v2 核心表 import_logs',
      },
    ];
    for (const testCase of cases) {
      const directory = temp('offerflow-export-reject-');
      const dbPath = path.join(directory, 'offerflow.sqlite3');
      const db = openDb(dbPath);
      try {
        initSchema(db, { targetVersion: testCase.version });
        testCase.mutate(db);
      } finally {
        db.close();
      }
      expect(
        () => exportSnapshotToDirectory(dbPath, path.join(directory, 'snapshot'), 'fixture-device'),
        testCase.name,
      ).toThrow(testCase.expected);
    }
  });
});
