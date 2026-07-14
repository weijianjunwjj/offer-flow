import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeedbackEventRecord } from '../../src/domain/job-memory';
import { makeApplication, makeEvent, makeVoidEvent } from '../../src/domain/job-memory/testFixtures';
import { openDb } from '../db';
import { initSchema } from '../schema';
import { getDatabaseSchemaVersion } from '../migrations';
import { JobRepository } from '../repositories/jobRepository';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { ResumeVersionRepository } from '../job-memory/resumeVersionRepository';
import { atomicWriteJson, sha256Hex, toStableJson } from '../sync/hash';
import { readSnapshotTable } from '../sync/tables';
import {
  SNAPSHOT_SCHEMA_VERSION,
  SYNC_TABLES,
  type OfferFlowSnapshot,
  type SnapshotManifest,
} from '../sync/types';
import {
  auditSnapshotV2Consistency,
  exportSnapshotV2,
  importSnapshotV2,
  runSnapshotV2Roundtrip,
  SNAPSHOT_V2_TABLES,
  upgradeLegacySnapshotV1OnTemporaryDatabase,
  type ExplicitSnapshotV2Context,
} from './v2';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function workspace(): { tempDir: string; context: ExplicitSnapshotV2Context } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-snapshot-v2-'));
  const databasePath = path.join(tempDir, 'source.sqlite3');
  const db = openDb(databasePath);
  initSchema(db, { targetVersion: 2 });
  db.close();
  cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  return {
    tempDir,
    context: {
      databasePath,
      snapshotDirectory: path.join(tempDir, 'snapshot-v2'),
      workingDirectory: tempDir,
      workspaceDirectory: process.cwd(),
      schemaTarget: 2,
      capability: 'job-memory-v2',
      mode: 'temporary_clone',
    },
  };
}

function seedV2(databasePath: string): void {
  const db = openDb(databasePath);
  try {
    new JobRepository(db).create({ id: 'job-1', company: 'Snapshot Fixture' });
    const resumes = new ResumeVersionRepository(db);
    resumes.insert({
      record: {
        id: 'resume-1', name: '简历一', source: 'pasted_text', contentHash: 'resume-content-hash',
        summary: '摘要', contentSnapshot: { resumeText: 'resume', projectExperience: 'project' },
        createdAt: 100, archivedAt: null, rowVersion: 1,
      },
      idempotencyKey: 'resume-key', requestHash: 'resume-request',
    });
    resumes.setActiveResumeVersionId('resume-1', 100);
    const applications = new ApplicationRepository(db);
    const first = makeApplication({ id: 'application-1', jobId: 'job-1', resumeVersionId: 'resume-1' });
    const second = makeApplication({
      id: 'application-2', jobId: 'job-1', createdAt: 200, updatedAt: 210,
      voidedAt: 210, voidReason: '误录流程', rowVersion: 2,
    });
    applications.insert({ record: first, idempotencyKey: 'app-key-1', requestHash: 'app-request-1', migrationKey: null });
    applications.insert({ record: second, idempotencyKey: 'app-key-2', requestHash: 'app-request-2', migrationKey: null });
    const events = new FeedbackEventRepository(db);
    const greeting = makeEvent('greeting_sent', {
      id: 'event-greeting', applicationId: first.id, idempotencyKey: 'event-key-greeting', createdAt: 101,
    });
    const rejected = makeEvent('rejected', {
      id: 'event-rejected', applicationId: first.id, idempotencyKey: 'event-key-rejected', createdAt: 102,
      payload: {},
    });
    const voided = makeVoidEvent(rejected, {
      id: 'event-void', idempotencyKey: 'event-key-void', createdAt: 103,
    });
    const replacement = makeEvent('hr_replied', {
      id: 'event-replacement', applicationId: first.id, idempotencyKey: 'event-key-replacement', createdAt: 104,
    });
    const applicationVoided = makeEvent('application_voided', {
      id: 'event-app-void', applicationId: second.id, idempotencyKey: 'event-key-app-void',
      createdAt: 210, payload: { reason: '误录流程' },
    });
    for (const event of [greeting, rejected, voided, replacement, applicationVoided] as FeedbackEventRecord[]) {
      events.insert({ record: event, requestHash: `request-${event.id}` });
    }
  } finally {
    db.close();
  }
}

function writeLegacySnapshot(directory: string, databasePath: string): void {
  const db = openDb(databasePath);
  let snapshot: OfferFlowSnapshot;
  try {
    snapshot = {
      schemaVersion: 1,
      exportedAt: '2026-07-14T00:00:00.000Z',
      deviceId: 'legacy-fixture',
      appVersion: '0.6.2',
      tables: Object.fromEntries(SYNC_TABLES.map((table) => [table, readSnapshotTable(db, table)])),
    } as OfferFlowSnapshot;
  } finally {
    db.close();
  }
  fs.mkdirSync(directory, { recursive: true });
  const text = toStableJson(snapshot);
  fs.writeFileSync(path.join(directory, 'offerflow.snapshot.json'), text, 'utf8');
  atomicWriteJson(path.join(directory, 'offerflow.manifest.json'), {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: snapshot.exportedAt,
    deviceId: snapshot.deviceId,
    appVersion: snapshot.appVersion,
    snapshotHash: sha256Hex(text),
    tableCounts: Object.fromEntries(
      SYNC_TABLES.map((table) => [table, snapshot.tables[table]?.rows.length ?? 0]),
    ),
  } satisfies SnapshotManifest);
}

describe('显式 snapshot v2', () => {
  it('导出/导入三张新表、active pointer、Event 引用和 payload，并通过 roundtrip', () => {
    const { context } = workspace();
    seedV2(context.databasePath);
    const exported = exportSnapshotV2(context);
    expect(exported.schemaVersion).toBe(2);
    expect(exported.tableCounts).toMatchObject({
      resume_versions: 1, applications: 2, feedback_events: 5,
    });
    expect(fs.existsSync(path.join(context.snapshotDirectory, 'offerflow.snapshot.json.tmp'))).toBe(false);
    exportSnapshotV2(context);
    expect(fs.existsSync(path.join(context.snapshotDirectory, 'offerflow.snapshot.json.tmp'))).toBe(false);

    const importedPath = path.join(context.workingDirectory, 'imported.sqlite3');
    const imported = importSnapshotV2({ ...context, databasePath: importedPath });
    expect(imported).toMatchObject({ schemaVersion: 2, integrity: ['ok'], foreignKeyViolationCount: 0 });
    expect(imported.importedRows).toMatchObject({
      resume_versions: 1, applications: 2, feedback_events: 5,
    });
    expect(auditSnapshotV2Consistency({ ...context, databasePath: importedPath }).ok).toBe(true);
    const importedDb = openDb(importedPath);
    try {
      expect(new ResumeVersionRepository(importedDb).getActiveResumeVersionId()).toBe('resume-1');
      expect(new FeedbackEventRepository(importedDb).getFeedbackEvent('event-void')).toMatchObject({
        targetEventId: 'event-rejected', payload: { targetEventId: 'event-rejected', targetEventType: 'rejected' },
      });
      expect(importedDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      importedDb.close();
    }
    expect(runSnapshotV2Roundtrip({
      ...context,
      snapshotDirectory: path.join(context.workingDirectory, 'roundtrip-snapshot'),
    })).toMatchObject({
      exportImportOk: true,
      consistencyOk: true,
      activeResumePointerPreserved: true,
      projectionPersisted: false,
      eventPayloadPreserved: true,
    });
    const parsed = JSON.parse(fs.readFileSync(
      path.join(context.snapshotDirectory, 'offerflow.snapshot.json'),
      'utf8',
    )) as { schemaVersion: number; tables: Record<string, { columns: string[] }> };
    expect(parsed.schemaVersion).toBe(2);
    expect(SNAPSHOT_V2_TABLES.every((table) => parsed.tables[table] !== undefined)).toBe(true);
    expect(parsed.tables.applications?.columns).not.toEqual(expect.arrayContaining(['stage', 'outcome', 'projection']));
  });

  it('空表可 roundtrip，schema mismatch 和源码工作区目标明确失败', () => {
    const { context } = workspace();
    expect(runSnapshotV2Roundtrip(context)).toMatchObject({
      consistencyOk: true,
      tableCounts: { resume_versions: 0, applications: 0, feedback_events: 0 },
    });
    expect(() => exportSnapshotV2({
      ...context,
      workingDirectory: process.cwd(),
      databasePath: path.join(process.cwd(), 'data', 'offerflow.sqlite3'),
      snapshotDirectory: path.join(process.cwd(), 'sync'),
    })).toThrow('源码工作区之外');
    const snapshotPath = path.join(context.snapshotDirectory, 'offerflow.snapshot.json');
    const manifestPath = path.join(context.snapshotDirectory, 'offerflow.manifest.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as Record<string, unknown>;
    snapshot.schemaVersion = 1;
    const text = toStableJson(snapshot);
    fs.writeFileSync(snapshotPath, text, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.snapshotHash = sha256Hex(text);
    atomicWriteJson(manifestPath, manifest);
    expect(() => importSnapshotV2({
      ...context,
      databasePath: path.join(context.workingDirectory, 'bad-import.sqlite3'),
    })).toThrow('schema mismatch');
  });
});

describe('snapshot v1 显式 legacy upgrade', () => {
  it('只在空 v2 求职记忆表导入并执行同一保守 backfill，非空时拒绝覆盖', () => {
    const { tempDir, context } = workspace();
    const legacyDbPath = path.join(tempDir, 'legacy-source.sqlite3');
    const legacyDb = openDb(legacyDbPath);
    try {
      initSchema(legacyDb);
      new JobRepository(legacyDb).create({
        id: 'legacy-replied', communicationStatus: 'replied', lastGreetedAt: 100,
      });
    } finally {
      legacyDb.close();
    }
    const legacySnapshotDirectory = path.join(tempDir, 'legacy-snapshot');
    writeLegacySnapshot(legacySnapshotDirectory, legacyDbPath);
    const targetPath = path.join(tempDir, 'legacy-upgrade-target.sqlite3');
    const result = upgradeLegacySnapshotV1OnTemporaryDatabase({
      ...context,
      databasePath: targetPath,
      legacySnapshotDirectory,
    });
    expect(result.backfill).toMatchObject({ createdApplications: 1, createdEvents: 1 });
    const target = openDb(targetPath);
    try {
      expect(getDatabaseSchemaVersion(target)).toBe(2);
      expect(target.prepare('SELECT COUNT(*) AS count FROM applications').get()).toEqual({ count: 1 });
      expect(new JobRepository(target).get('legacy-replied')).toMatchObject({
        communicationStatus: 'replied', lastGreetedAt: 100,
      });
    } finally {
      target.close();
    }
    expect(() => upgradeLegacySnapshotV1OnTemporaryDatabase({
      ...context,
      databasePath: targetPath,
      legacySnapshotDirectory,
    })).toThrow('不得覆盖已有 v2');
  });
});
