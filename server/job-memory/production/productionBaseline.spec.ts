import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  makeApplication,
  makeEvent,
  makeLegacyEvent,
  makeVoidEvent,
} from '../../../src/domain/job-memory/testFixtures';
import { openDb } from '../../db';
import { initSchema } from '../../schema';
import { LATEST_SCHEMA_VERSION } from '../../migrations';
import { JobRepository } from '../../repositories/jobRepository';
import { exportSnapshotToDirectory } from '../../sync/exportSnapshot';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import { ResumeVersionRepository } from '../resumeVersionRepository';
import { captureCurrentProductionState, verifyCurrentProductionDatabase } from './currentVerification';
import { publishCurrentProductionSnapshot } from './snapshotPublish';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface Fixture {
  root: string;
  databasePath: string;
  snapshotDirectory: string;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-production-verify-'));
  const databasePath = path.join(root, 'offerflow.sqlite3');
  const snapshotDirectory = path.join(root, 'snapshot');
  const db = openDb(databasePath);
  initSchema(db, { targetVersion: 2 });
  db.close();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, databasePath, snapshotDirectory };
}

function fixtureAt(targetVersion: number): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-verify-vN-'));
  const databasePath = path.join(root, 'offerflow.sqlite3');
  const snapshotDirectory = path.join(root, 'snapshot');
  const db = openDb(databasePath);
  initSchema(db, { targetVersion });
  db.close();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, databasePath, snapshotDirectory };
}

function seedHistoricalShape(databasePath: string): void {
  const db = openDb(databasePath);
  try {
    const jobs = new JobRepository(db);
    const applications = new ApplicationRepository(db);
    const events = new FeedbackEventRepository(db);
    for (let index = 0; index < 13; index += 1) {
      jobs.create({ id: `job-${index}`, company: `合成公司-${index}` });
    }
    db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)')
      .run('default', '{"targetRole":"fixture"}', 1);
    for (let index = 0; index < 7; index += 1) {
      const application = makeApplication({
        id: `application-${index}`,
        jobId: `job-${index}`,
        createdAt: 100 + index,
        updatedAt: 100 + index,
      });
      applications.insert({
        record: application,
        idempotencyKey: `application-key-${index}`,
        requestHash: `application-request-${index}`,
        migrationKey: `legacy-migration-${index}`,
      });
      const event = makeLegacyEvent({
        id: `legacy-event-${index}`,
        applicationId: application.id,
        idempotencyKey: `legacy-event-key-${index}`,
        createdAt: 200 + index,
      });
      events.insert({ record: event, requestHash: `legacy-event-request-${index}` });
    }
  } finally {
    db.close();
  }
}

function addNormalUserGrowth(databasePath: string): void {
  const db = openDb(databasePath);
  try {
    new JobRepository(db).create({ id: 'job-user-growth', company: '合成新增公司' });
    const resumes = new ResumeVersionRepository(db);
    resumes.insert({
      record: {
        id: 'resume-user-growth',
        name: '合成简历',
        source: 'pasted_text',
        contentHash: 'resume-user-growth-content',
        summary: '合成摘要',
        contentSnapshot: { resumeText: 'resume', projectExperience: 'project' },
        createdAt: 1_000,
        archivedAt: null,
        rowVersion: 1,
      },
      idempotencyKey: 'resume-user-growth-key',
      requestHash: 'resume-user-growth-request',
    });
    resumes.setActiveResumeVersionId('resume-user-growth', 1_000);
    const application = makeApplication({
      id: 'application-user-growth',
      jobId: 'job-user-growth',
      resumeVersionId: 'resume-user-growth',
      origin: 'outbound',
      channel: 'boss',
      cityContext: { jobCity: '苏州', marketCity: '苏州', workMode: 'onsite' },
      createdAt: 1_010,
      updatedAt: 1_010,
    });
    new ApplicationRepository(db).insert({
      record: application,
      idempotencyKey: 'application-user-growth-key',
      requestHash: 'application-user-growth-request',
      migrationKey: null,
    });
    const events = new FeedbackEventRepository(db);
    const created = makeEvent('application_created', {
      id: 'event-user-growth-created',
      applicationId: application.id,
      idempotencyKey: 'event-user-growth-created-key',
      createdAt: 1_010,
      eventAt: 1_010,
    });
    const applied = makeEvent('applied', {
      id: 'event-user-growth-applied',
      applicationId: application.id,
      idempotencyKey: 'event-user-growth-applied-key',
      createdAt: 1_020,
      eventAt: 1_020,
    });
    events.insert({ record: created, requestHash: 'event-user-growth-created-request' });
    events.insert({ record: applied, requestHash: 'event-user-growth-applied-request' });
  } finally {
    db.close();
  }
}

function syncSnapshot(target: Fixture): void {
  exportSnapshotToDirectory(target.databasePath, target.snapshotDirectory, 'fixture-device');
}

describe('当前生产只读 verifier', () => {
  it('接受 B7-B 旧聚合和合法用户增长，Snapshot 落后时失败、同步后通过', () => {
    const target = fixture();
    seedHistoricalShape(target.databasePath);
    syncSnapshot(target);
    expect(verifyCurrentProductionDatabase(target.databasePath, {
      snapshotDirectory: target.snapshotDirectory,
    }).tableCounts).toMatchObject({
      jobs: 13, resumeVersions: 0, applications: 7, feedbackEvents: 7,
    });

    addNormalUserGrowth(target.databasePath);
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      snapshotDirectory: target.snapshotDirectory,
    })).toThrow('正式 Snapshot 与当前生产数据库不一致');

    syncSnapshot(target);
    const before = captureCurrentProductionState(target.databasePath);
    const report = verifyCurrentProductionDatabase(target.databasePath, {
      snapshotDirectory: target.snapshotDirectory,
    });
    const after = captureCurrentProductionState(target.databasePath);
    expect(report.tableCounts).toMatchObject({
      jobs: 14, resumeVersions: 1, applications: 8, feedbackEvents: 9,
    });
    expect(report).toMatchObject({
      snapshotConsistent: true,
      snapshotDifferenceCount: 0,
      normalizedFingerprintUnchanged: true,
      verifierBusinessWrites: 0,
      projection: { invalid: 0 },
    });
    expect(after).toEqual(before);
  });

  it('检测验证运行期间的外部写入且 verifier 自身不写入', () => {
    const target = fixture();
    seedHistoricalShape(target.databasePath);
    syncSnapshot(target);
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      snapshotDirectory: target.snapshotDirectory,
      afterValidation: () => {
        const db = openDb(target.databasePath);
        try {
          new JobRepository(db).create({ id: 'concurrent-job', company: '合成并发写入' });
        } finally {
          db.close();
        }
      },
    })).toThrow('规范化指纹发生变化');
  });

  it('invalid Projection 与跨 Application void target 明确失败', () => {
    const target = fixture();
    seedHistoricalShape(target.databasePath);
    const db = openDb(target.databasePath);
    try {
      const events = new FeedbackEventRepository(db);
      const targetEvent = events.getFeedbackEvent('legacy-event-1');
      if (targetEvent === null) throw new Error('fixture event missing');
      const invalidVoid = makeVoidEvent(targetEvent, {
        id: 'cross-application-void',
        applicationId: 'application-0',
        idempotencyKey: 'cross-application-void-key',
      });
      events.insert({ record: invalidVoid, requestHash: 'cross-application-void-request' });
    } finally {
      db.close();
    }
    syncSnapshot(target);
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      snapshotDirectory: target.snapshotDirectory,
    })).toThrow(/invalid ApplicationProjection|非法 Event void target/u);
  });

  it('孤儿引用与 active pointer 异常分别失败', () => {
    const orphan = fixture();
    seedHistoricalShape(orphan.databasePath);
    const orphanDb = openDb(orphan.databasePath);
    try {
      orphanDb.pragma('foreign_keys = OFF');
      orphanDb.prepare(`
        INSERT INTO feedback_events (
          id, application_id, event_type, event_at, time_precision, actor,
          recorded_by, source_confidence, evidence_level, channel, note,
          reason_code, payload_json, target_event_id, idempotency_key,
          request_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'orphan-void', 'application-0', 'event_voided', 1_000, 'exact', 'user',
        'user', 'exact', 'strong', 'boss', null, null,
        JSON.stringify({ targetEventId: 'missing-target', targetEventType: 'applied', reason: '合成错误' }),
        'missing-target', 'orphan-void-key', 'orphan-void-request', 1_000,
      );
    } finally {
      orphanDb.close();
    }
    syncSnapshot(orphan);
    expect(() => verifyCurrentProductionDatabase(orphan.databasePath, {
      snapshotDirectory: orphan.snapshotDirectory,
    })).toThrow('外键违规');

    const active = fixture();
    seedHistoricalShape(active.databasePath);
    addNormalUserGrowth(active.databasePath);
    const activeDb = openDb(active.databasePath);
    try {
      activeDb.prepare('UPDATE resume_versions SET archived_at = ? WHERE id = ?')
        .run(2_000, 'resume-user-growth');
    } finally {
      activeDb.close();
    }
    syncSnapshot(active);
    expect(() => verifyCurrentProductionDatabase(active.databasePath, {
      snapshotDirectory: active.snapshotDirectory,
    })).toThrow('active ResumeVersion pointer');
  });
});

describe('当前生产 Snapshot 原子发布', () => {
  it('真实生产形状 staging/roundtrip 后原子发布并达到差异 0', () => {
    const target = fixture();
    seedHistoricalShape(target.databasePath);
    syncSnapshot(target);
    addNormalUserGrowth(target.databasePath);
    const report = publishCurrentProductionSnapshot({
      databasePath: target.databasePath,
      workspaceDirectory: process.cwd(),
      snapshotDirectory: target.snapshotDirectory,
      deviceId: 'fixture-device',
    });
    expect(report).toMatchObject({
      schemaVersion: 2,
      tableCounts: { resumeVersions: 1, applications: 8, feedbackEvents: 9 },
      stagingConsistency: true,
      roundtrip: true,
      atomicPublish: true,
      formalDifferenceCount: 0,
      sourceFingerprintUnchanged: true,
    });
  });

  it('双文件发布故障时完整保留旧正式 Snapshot pair', () => {
    const target = fixture();
    seedHistoricalShape(target.databasePath);
    syncSnapshot(target);
    const oldSnapshot = fs.readFileSync(path.join(target.snapshotDirectory, 'offerflow.snapshot.json'), 'utf8');
    const oldManifest = fs.readFileSync(path.join(target.snapshotDirectory, 'offerflow.manifest.json'), 'utf8');
    addNormalUserGrowth(target.databasePath);
    expect(() => publishCurrentProductionSnapshot({
      databasePath: target.databasePath,
      workspaceDirectory: process.cwd(),
      snapshotDirectory: target.snapshotDirectory,
      deviceId: 'fixture-device',
      failAfterSnapshotReplace: true,
    })).toThrow('B7B_TEST_SNAPSHOT_PUBLISH_FAILURE');
    expect(fs.readFileSync(path.join(target.snapshotDirectory, 'offerflow.snapshot.json'), 'utf8'))
      .toBe(oldSnapshot);
    expect(fs.readFileSync(path.join(target.snapshotDirectory, 'offerflow.manifest.json'), 'utf8'))
      .toBe(oldManifest);
    expect(fs.readdirSync(target.snapshotDirectory).some((name) => name.includes('.rollback.tmp')))
      .toBe(false);
  });
});

describe('增量架构生产 verifier（v2 底座 + 纯增量升级）', () => {
  it('接受 v2/v7/v8 生产库并返回真实 schemaVersion', () => {
    for (const version of [2, 7, 8]) {
      const target = fixtureAt(version);
      seedHistoricalShape(target.databasePath);
      const report = verifyCurrentProductionDatabase(target.databasePath, {
        requireSnapshotConsistency: false,
      });
      expect(report).toMatchObject({
        schemaVersion: version,
        appMetaSchemaVersion: version,
        migrationContinuous: true,
        integrity: 'ok',
        foreignKeyViolationCount: 0,
      });
      expect(report.tableCounts).toMatchObject({ jobs: 13, applications: 7, feedbackEvents: 7 });
    }
  });

  it('拒绝未知未来版本', () => {
    const target = fixtureAt(LATEST_SCHEMA_VERSION);
    const db = openDb(target.databasePath);
    try {
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(LATEST_SCHEMA_VERSION + 1, `${LATEST_SCHEMA_VERSION + 1}_unknown_future`, 1);
      db.prepare("UPDATE app_meta SET value = ? WHERE key = 'schema_version'")
        .run(String(LATEST_SCHEMA_VERSION + 1));
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow(/newer than this application supports/u);
  });

  it('拒绝 migration 缺口', () => {
    const target = fixtureAt(7);
    const db = openDb(target.databasePath);
    try {
      db.prepare('DELETE FROM schema_migrations WHERE version = 5').run();
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow(/version gap or out-of-order/u);
  });

  it('拒绝 migration 名称被篡改', () => {
    const target = fixtureAt(7);
    const db = openDb(target.databasePath);
    try {
      db.prepare('UPDATE schema_migrations SET name = ? WHERE version = 5').run('005_tampered');
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow(/name conflict/u);
  });

  it('拒绝 app_meta schema_version 与 migration 不一致', () => {
    const target = fixtureAt(7);
    const db = openDb(target.databasePath);
    try {
      db.prepare("UPDATE app_meta SET value = '6' WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow('app_meta schema_version 与 migration 不一致');
  });

  it('拒绝缺失 v2 核心表', () => {
    const target = fixtureAt(2);
    const db = openDb(target.databasePath);
    try {
      db.exec('DROP TABLE import_logs');
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow('缺少 v2 核心表 import_logs');
  });

  it('拒绝缺失 v2 核心字段', () => {
    const target = fixtureAt(2);
    const db = openDb(target.databasePath);
    try {
      db.exec('ALTER TABLE jobs DROP COLUMN data_json');
    } finally {
      db.close();
    }
    expect(() => verifyCurrentProductionDatabase(target.databasePath, {
      requireSnapshotConsistency: false,
    })).toThrow('缺少字段 data_json');
  });
});
