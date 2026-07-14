import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../db';
import { initSchema } from '../../schema';
import { JobRepository } from '../../repositories/jobRepository';
import { atomicWriteJson, sha256Hex, toStableJson } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SYNC_TABLES,
  type OfferFlowSnapshot,
  type SnapshotManifest,
} from '../../sync/types';
import { createUpgradeBackup, verifyUpgradeBackup } from './backup';
import { runUpgradeDryRun } from './dryRun';
import { inspectSourceDatabase } from './inspection';
import { assertDistinctDatabasePaths, resolveUpgradePaths } from './pathSafety';
import { parseUpgradeCliArgs } from '../../../scripts/jobMemoryV2Upgrade';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  tempDir: string;
  workspaceDirectory: string;
  sourceDatabasePath: string;
  backupDirectory: string;
}

function fixture(): Fixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b7-backup-'));
  const workspaceDirectory = path.join(tempDir, 'workspace');
  const sourceDatabasePath = path.join(tempDir, 'source', 'offerflow.sqlite3');
  const backupDirectory = path.join(tempDir, 'safe-backups');
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  fs.writeFileSync(path.join(workspaceDirectory, '.gitignore'), 'backups/\n', 'utf8');
  fs.writeFileSync(path.join(workspaceDirectory, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['init'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: workspaceDirectory, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: workspaceDirectory, windowsHide: true });
  execFileSync('git', ['add', 'README.md', '.gitignore'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspaceDirectory, stdio: 'ignore', windowsHide: true });
  const db = openDb(sourceDatabasePath);
  initSchema(db);
  db.close();
  cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return { tempDir, workspaceDirectory, sourceDatabasePath, backupDirectory };
}

function writeSnapshotV1(target: Fixture): void {
  const db = openDb(target.sourceDatabasePath);
  let snapshot: OfferFlowSnapshot;
  try {
    snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt: '2026-07-14T00:00:00.000Z',
      deviceId: 'fixture-device',
      appVersion: '0.6.2',
      tables: Object.fromEntries(
        SYNC_TABLES.map((table) => [table, readSnapshotTable(db, table)]),
      ),
    } as OfferFlowSnapshot;
  } finally {
    db.close();
  }
  const syncDir = path.join(target.workspaceDirectory, 'sync');
  fs.mkdirSync(syncDir, { recursive: true });
  const snapshotText = toStableJson(snapshot);
  fs.writeFileSync(path.join(syncDir, 'offerflow.snapshot.json'), snapshotText, 'utf8');
  atomicWriteJson(path.join(syncDir, 'offerflow.manifest.json'), {
    schemaVersion: 1,
    exportedAt: snapshot.exportedAt,
    deviceId: snapshot.deviceId,
    appVersion: snapshot.appVersion,
    snapshotHash: sha256Hex(snapshotText),
    tableCounts: Object.fromEntries(
      SYNC_TABLES.map((table) => [table, snapshot.tables[table]?.rows.length ?? 0]),
    ),
  } satisfies SnapshotManifest);
}

function options(target: Fixture) {
  return {
    sourceDatabasePath: target.sourceDatabasePath,
    backupDirectory: target.backupDirectory,
    workspaceDirectory: target.workspaceDirectory,
  };
}

function seedMixedJobs(target: Fixture): void {
  const db = openDb(target.sourceDatabasePath);
  try {
    const jobs = new JobRepository(db);
    jobs.create({ id: 'job-uncontacted', company: '仅测试未投递' });
    jobs.create({ id: 'job-replied', company: '仅测试回复', communicationStatus: 'replied' });
    jobs.create({ id: 'job-rejected', company: '仅测试模糊拒绝', communicationStatus: 'rejected' });
    jobs.create({
      id: 'job-paused', company: '仅测试暂停', communicationStatus: 'paused',
      lastFollowupAt: 100, followupCount: 1, lastCommunicationNote: '仅测试私密备注',
    });
  } finally {
    db.close();
  }
}

describe('B7-A 只读审计和安全备份', () => {
  it('CLI 只暴露四个只读/克隆模式，不接受 apply、force 或缺省路径', () => {
    expect(() => parseUpgradeCliArgs(['apply'])).toThrow('仅支持');
    expect(() => parseUpgradeCliArgs([
      'inspect', '--source', 'source.sqlite3', '--backup-dir', 'backups',
      '--workspace', '.', '--force', 'true',
    ])).toThrow('不支持');
    expect(() => parseUpgradeCliArgs(['dry-run', '--source', 'source.sqlite3']))
      .toThrow('缺少必填参数');
    expect(parseUpgradeCliArgs([
      'verify-backup', '--source', 'source.sqlite3', '--backup-dir', 'backups',
      '--workspace', '.', '--backup-id', '20260714-010203-b7a-deadbeef',
    ]).mode).toBe('verify-backup');
  });

  it('生成在线备份、无敏感 manifest，并拒绝覆盖已有 backup ID', async () => {
    const target = fixture();
    seedMixedJobs(target);
    writeSnapshotV1(target);
    const inspection = inspectSourceDatabase(options(target));
    expect(inspection).toMatchObject({
      schemaVersion: 1,
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
      v2TablesPresent: [],
      upgradeEligible: true,
      snapshotV1: { hashValid: true, consistencyOk: true },
    });
    const sourceHash = sha256Hex(fs.readFileSync(target.sourceDatabasePath));
    const backupId = '20260714-010203-b7a-deadbeef';
    const created = await createUpgradeBackup({ ...options(target), backupId });
    expect(created.manifest).toMatchObject({
      backupId,
      sourceSchemaVersion: 1,
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
      snapshotV1: { present: true },
    });
    expect(created.manifest.snapshotV1.files).toHaveLength(2);
    const manifestText = fs.readFileSync(
      path.join(created.backupDirectory, 'backup-manifest.json'),
      'utf8',
    );
    expect(manifestText).not.toContain(target.tempDir);
    expect(manifestText).not.toContain('仅测试回复');
    expect(manifestText).not.toContain('job-replied');
    expect(sha256Hex(fs.readFileSync(target.sourceDatabasePath))).toBe(sourceHash);
    await expect(createUpgradeBackup({ ...options(target), backupId })).rejects.toThrow('禁止覆盖');
    expect(fs.existsSync(path.join(created.backupDirectory, 'backup-manifest.json'))).toBe(true);
    expect((await verifyUpgradeBackup({ ...options(target), backupId })).ok).toBe(true);
  });

  it('拒绝相同源/目标、仓库内未忽略目录和损坏备份，且不删除旧备份', async () => {
    const target = fixture();
    expect(() => assertDistinctDatabasePaths(target.sourceDatabasePath, target.sourceDatabasePath))
      .toThrow('不得相同');
    expect(() => resolveUpgradePaths({
      ...options(target),
      backupDirectory: path.join(target.workspaceDirectory, 'unsafe-backups'),
    })).toThrow('.gitignore');
    writeSnapshotV1(target);
    const backupId = '20260714-010203-b7a-aaaaaaaa';
    const created = await createUpgradeBackup({ ...options(target), backupId });
    fs.appendFileSync(path.join(created.backupDirectory, 'offerflow-v1.sqlite3'), 'tamper');
    await expect(verifyUpgradeBackup({ ...options(target), backupId })).rejects.toThrow('hash/size');
    expect(fs.existsSync(created.backupDirectory)).toBe(true);
  });
});

describe('B7-A 克隆库完整 dry-run', () => {
  it('只迁移可靠流程、幂等、roundtrip，并清理 disposable clone', async () => {
    const target = fixture();
    seedMixedJobs(target);
    writeSnapshotV1(target);
    const sourceHash = sha256Hex(fs.readFileSync(target.sourceDatabasePath));
    const tempBefore = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('offerflow-job-memory-v2-upgrade-')),
    );
    const backupId = '20260714-010203-b7a-bbbbbbbb';
    const backup = await createUpgradeBackup({ ...options(target), backupId });
    const report = await runUpgradeDryRun({ ...options(target), backupId });
    expect(report).toMatchObject({
      sourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      wouldCreateApplications: 2,
      wouldCreateLegacySeeds: 2,
      skipCount: 2,
      manualReviewCount: 0,
      projectionHealth: { valid: 0, degraded: 2, invalid: 0 },
      secondRun: { createdApplications: 0, createdEvents: 0, auditLogCreated: false },
      jobHashChangeCount: 0,
      profileRowsUnchanged: true,
      originalImportLogRowsUnchanged: true,
      integrity: ['ok'],
      foreignKeyViolationCount: 0,
      sourceUnchanged: true,
      backupDatabaseUnchanged: true,
      formalSnapshotUnchanged: true,
      disposableCloneRemoved: true,
      snapshotV2: {
        exportImportOk: true,
        consistencyOk: true,
        activeResumePointerPreserved: true,
        projectionPersisted: false,
        eventPayloadPreserved: true,
      },
    });
    expect(sha256Hex(fs.readFileSync(target.sourceDatabasePath))).toBe(sourceHash);
    expect(fs.existsSync(path.join(backup.backupDirectory, 'offerflow-v1.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(backup.backupDirectory, 'dry-run-report.json'))).toBe(true);
    const reportText = fs.readFileSync(path.join(backup.backupDirectory, 'dry-run-report.json'), 'utf8');
    expect(reportText).not.toContain(target.tempDir);
    expect(reportText).not.toContain('仅测试私密备注');
    expect(reportText).not.toContain('job-paused');
    const tempAfter = new Set(
      fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('offerflow-job-memory-v2-upgrade-')),
    );
    expect(tempAfter).toEqual(tempBefore);
  });
});
