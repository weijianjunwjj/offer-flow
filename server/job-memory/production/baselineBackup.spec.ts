import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db';
import { JobRepository } from '../../repositories/jobRepository';
import { initSchema } from '../../schema';
import { exportSnapshotToDirectory } from '../../sync/exportSnapshot';
import { captureCurrentProductionState } from './currentVerification';
import {
  createCurrentBaselineBackup,
  verifyCurrentBaselineBackup,
  verifyCurrentBaselineBackupMatchesSource,
} from './baselineBackup';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('R0.1 pre-sync 一致性备份', () => {
  it('online backup 保存 schema v2 和旧 Snapshot pair，manifest 无正文/绝对路径且禁止覆盖', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-r01-backup-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'offerflow.sqlite3');
    const snapshotDirectory = path.join(root, 'snapshot');
    const backupDirectory = path.join(root, 'backups');
    const db = openDb(databasePath);
    try {
      initSchema(db, { targetVersion: 2 });
      new JobRepository(db).create({ id: 'backup-job', company: '不得进入 manifest 的合成正文' });
    } finally {
      db.close();
    }
    exportSnapshotToDirectory(databasePath, snapshotDirectory, 'fixture-device');
    const before = captureCurrentProductionState(databasePath);
    const backupId = '20260714-160000-r01-deadbeef';
    const result = await createCurrentBaselineBackup({
      sourceDatabasePath: databasePath,
      backupDirectory,
      workspaceDirectory: process.cwd(),
      snapshotDirectory,
      backupId,
      now: new Date('2026-07-14T08:00:00.000Z'),
    });
    expect(result).toMatchObject({
      backupId,
      snapshotFilesVerified: 2,
      sourceFingerprintUnchanged: true,
    });
    expect(verifyCurrentBaselineBackup(backupDirectory, backupId)).toMatchObject({
      backupId,
      snapshotFilesVerified: 2,
    });
    expect(verifyCurrentBaselineBackupMatchesSource(
      backupDirectory,
      backupId,
      databasePath,
    )).toMatchObject({ backupId });
    expect(captureCurrentProductionState(databasePath)).toEqual(before);
    const manifestText = fs.readFileSync(
      path.join(backupDirectory, backupId, 'backup-manifest.json'),
      'utf8',
    );
    expect(manifestText).not.toContain(root);
    expect(manifestText).not.toContain('不得进入 manifest');
    await expect(createCurrentBaselineBackup({
      sourceDatabasePath: databasePath,
      backupDirectory,
      workspaceDirectory: process.cwd(),
      snapshotDirectory,
      backupId,
    })).rejects.toThrow('禁止覆盖');
    const changed = openDb(databasePath);
    try {
      new JobRepository(changed).create({ id: 'post-backup-change', company: '合成后续变更' });
    } finally {
      changed.close();
    }
    expect(() => verifyCurrentBaselineBackupMatchesSource(
      backupDirectory,
      backupId,
      databasePath,
    )).toThrow('备份与当前生产数据库不一致');
  });

  it('在纯增量升级后的 v7 生产库上创建并校验备份/恢复副本', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-r01-backup-v7-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'offerflow.sqlite3');
    const snapshotDirectory = path.join(root, 'snapshot');
    const backupDirectory = path.join(root, 'backups');
    const db = openDb(databasePath);
    try {
      initSchema(db, { targetVersion: 7 });
      new JobRepository(db).create({ id: 'v7-job', company: '合成 v7 公司' });
    } finally {
      db.close();
    }
    // v7 纯增量升级库导出真实核心业务 Snapshot pair（仅 7 张核心表，不含 Radar 表）。
    exportSnapshotToDirectory(databasePath, snapshotDirectory, 'fixture-device-v7');
    const before = captureCurrentProductionState(databasePath);
    const backupId = '20260714-170000-r01-feedface';
    const result = await createCurrentBaselineBackup({
      sourceDatabasePath: databasePath,
      backupDirectory,
      workspaceDirectory: process.cwd(),
      snapshotDirectory,
      backupId,
      now: new Date('2026-07-14T09:00:00.000Z'),
    });
    expect(result).toMatchObject({ backupId, snapshotFilesVerified: 2, sourceFingerprintUnchanged: true });
    const manifestText = fs.readFileSync(
      path.join(backupDirectory, backupId, 'backup-manifest.json'),
      'utf8',
    );
    expect(JSON.parse(manifestText).sourceSchemaVersion).toBe(7);
    expect(verifyCurrentBaselineBackup(backupDirectory, backupId)).toMatchObject({ backupId });
    expect(verifyCurrentBaselineBackupMatchesSource(backupDirectory, backupId, databasePath))
      .toMatchObject({ backupId });
    expect(captureCurrentProductionState(databasePath)).toEqual(before);
  });

  it('在纯增量升级后的 v8 生产库上创建并校验备份/恢复副本（恢复链路不被陈旧 ===2 阻断）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-r01-backup-v8-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'offerflow.sqlite3');
    const snapshotDirectory = path.join(root, 'snapshot');
    const backupDirectory = path.join(root, 'backups');
    const db = openDb(databasePath);
    try {
      initSchema(db, { targetVersion: 8 });
      new JobRepository(db).create({ id: 'v8-job', company: '合成 v8 公司' });
    } finally {
      db.close();
    }
    // v8 纯增量升级库导出真实核心业务 Snapshot pair（仅 7 张核心表，不含 Radar 表）。
    exportSnapshotToDirectory(databasePath, snapshotDirectory, 'fixture-device-v8');
    const before = captureCurrentProductionState(databasePath);
    const backupId = '20260714-180000-r01-cafebabe';
    const result = await createCurrentBaselineBackup({
      sourceDatabasePath: databasePath,
      backupDirectory,
      workspaceDirectory: process.cwd(),
      snapshotDirectory,
      backupId,
      now: new Date('2026-07-14T10:00:00.000Z'),
    });
    expect(result).toMatchObject({ backupId, snapshotFilesVerified: 2, sourceFingerprintUnchanged: true });
    expect(JSON.parse(fs.readFileSync(
      path.join(backupDirectory, backupId, 'backup-manifest.json'),
      'utf8',
    )).sourceSchemaVersion).toBe(8);
    // 实际恢复链路：verify 与 matchesSource 均放行 v8，证明 ===2 陈旧门禁已解除。
    expect(verifyCurrentBaselineBackup(backupDirectory, backupId)).toMatchObject({ backupId });
    expect(verifyCurrentBaselineBackupMatchesSource(backupDirectory, backupId, databasePath))
      .toMatchObject({ backupId });
    expect(captureCurrentProductionState(databasePath)).toEqual(before);
  });

  it('备份/恢复链路仍拒绝未知未来版本、缺号、篡改、app_meta 不一致与核心结构损坏', async () => {
    const cases: Array<{
      name: string;
      version: number;
      mutate: (db: ReturnType<typeof openDb>) => void;
      expected: RegExp | string;
    }> = [
      {
        name: '未知未来版本 v9',
        version: 8,
        mutate: (db) => {
          db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
            .run(9, '009_unknown_future', 1);
          db.prepare("UPDATE app_meta SET value = '9' WHERE key = 'schema_version'").run();
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
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-r01-reject-'));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      const databasePath = path.join(root, 'offerflow.sqlite3');
      const db = openDb(databasePath);
      try {
        initSchema(db, { targetVersion: testCase.version });
        testCase.mutate(db);
      } finally {
        db.close();
      }
      await expect(createCurrentBaselineBackup({
        sourceDatabasePath: databasePath,
        backupDirectory: path.join(root, 'backups'),
        workspaceDirectory: process.cwd(),
        snapshotDirectory: path.join(root, 'snapshot'),
        backupId: '20260714-190000-r01-0badf00d',
      }), testCase.name).rejects.toThrow(testCase.expected);
    }
  });
});
