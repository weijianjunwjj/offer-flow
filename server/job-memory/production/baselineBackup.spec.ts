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
});
