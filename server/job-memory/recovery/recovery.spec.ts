import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSnapshotResumeDrill } from './drills';
import { openDb } from '../../db';
import { initSchema } from '../../schema';
import { auditSnapshotConsistency } from '../../sync/consistency';

const temporaryPrefixes = [
  'offerflow-b8-resume-',
  'offerflow-b8-v1-restore-',
  'offerflow-b8-v2-restore-',
  'offerflow-b8-production-',
];

function temporaryEntries(): string[] {
  return fs.readdirSync(os.tmpdir())
    .filter((name) => temporaryPrefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
}

describe('B8 数据库提交后 Snapshot 续发恢复', () => {
  it('故障注入后只续发 Snapshot，最终 resolved 且二次 resume 幂等', async () => {
    const before = temporaryEntries();
    const report = await runSnapshotResumeDrill(process.cwd());
    expect(report).toMatchObject({
      databaseTransactionCommitted: true,
      snapshotFailureInjected: true,
      partialState: {
        databaseCommitted: true,
        snapshotPublished: false,
        resolved: false,
      },
      schemaAfterFailure: 2,
      secondRunAdditions: { applications: 0, events: 0, audit: false },
      normalApplyRepeatRejected: true,
      resumeBindingsVerified: true,
      repeatedBackfill: false,
      countsUnchangedDuringResume: true,
      finalState: {
        databaseCommitted: true,
        snapshotPublished: true,
        resolved: true,
      },
      postUpgradeBackupBound: true,
      secondResume: 'already-resolved',
      secondResumeSnapshotUnchanged: true,
      temporaryDirectoryRemoved: true,
      touchedRealDatabase: false,
    });
    expect(temporaryEntries()).toEqual(before);
  });

  it('全新 clone 缺少正式 Snapshot 时给出初始化或恢复指引', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b8-missing-snapshot-'));
    const databasePath = path.join(directory, 'offerflow.sqlite3');
    const previousSyncDirectory = process.env.OFFERFLOW_SYNC_DIR;
    process.env.OFFERFLOW_SYNC_DIR = path.join(directory, 'sync');
    try {
      const db = openDb(databasePath);
      initSchema(db, { targetVersion: 2 });
      db.close();
      expect(() => auditSnapshotConsistency(databasePath)).toThrow(/初始化.*恢复.*不能.*consistency/u);
    } finally {
      if (previousSyncDirectory === undefined) delete process.env.OFFERFLOW_SYNC_DIR;
      else process.env.OFFERFLOW_SYNC_DIR = previousSyncDirectory;
      fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(fs.existsSync(directory)).toBe(false);
  });
});
