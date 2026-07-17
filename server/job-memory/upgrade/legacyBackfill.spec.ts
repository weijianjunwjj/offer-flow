import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectApplication } from '../../../src/domain/job-memory';
import { openDb, type SqliteDatabase } from '../../db';
import { initSchema } from '../../schema';
import { JobRepository } from '../../repositories/jobRepository';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import { classifyLegacyBackfill, runLegacyBackfill } from './legacyBackfill';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): { db: SqliteDatabase; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-b7-backfill-'));
  const db = openDb(path.join(tempDir, 'fixture.sqlite3'));
  initSchema(db, { targetVersion: 2 });
  cleanups.push(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { db, tempDir };
}

function sha(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('B7-A 保守 legacy 分类器', () => {
  it.each([
    ['not_contacted', 0, undefined, 'skip'],
    ['greeted_unread', 0, undefined, 'create_application'],
    ['greeted_read_no_reply', 0, undefined, 'create_application'],
    ['replied', 0, undefined, 'create_application'],
    ['interviewing', 0, undefined, 'create_application'],
    ['paused', 0, undefined, 'skip'],
    ['closed', 0, undefined, 'skip'],
    ['rejected', 0, undefined, 'skip'],
    ['paused', 1, undefined, 'create_application'],
    ['closed', 0, 100, 'create_application'],
    ['rejected', 0, 100, 'create_application'],
  ] as const)('%s 按证据门槛分类', (communicationStatus, followupCount, lastGreetedAt, action) => {
    expect(classifyLegacyBackfill({
      communicationStatus, followupCount, lastGreetedAt,
    }).action).toBe(action);
  });

  it('import review、非法字段、unknown/false 和 note-only 保守处理', () => {
    expect(classifyLegacyBackfill({
      communicationStatus: 'rejected', followupCount: 0, reviewStatus: 'rejected',
    })).toEqual({ action: 'skip', reason: 'import_review_rejected_without_interaction' });
    expect(classifyLegacyBackfill({
      communicationStatus: 'paused', followupCount: 0, reviewStatus: 'deferred',
    }).action).toBe('skip');
    expect(classifyLegacyBackfill({
      communicationStatus: 'replied', followupCount: 0, reviewStatus: 'rejected',
    }).action).toBe('manual_review');
    expect(classifyLegacyBackfill({ communicationStatus: 'unknown', followupCount: 0 }).action)
      .toBe('manual_review');
    expect(classifyLegacyBackfill({ communicationStatus: 'replied', followupCount: false }).action)
      .toBe('manual_review');
    expect(classifyLegacyBackfill({
      communicationStatus: 'closed', followupCount: 0, lastCommunicationNote: '只有备注',
    }).action).toBe('skip');
    expect(classifyLegacyBackfill({
      communicationStatus: 'not_contacted', followupCount: 1,
    }).action).toBe('manual_review');
  });

  it('缺失时间不伪造，跟进次数只有弱证据 warning', () => {
    expect(classifyLegacyBackfill({
      communicationStatus: 'paused', followupCount: 1,
    })).toMatchObject({
      action: 'create_application',
      confidence: 'weak',
      warnings: ['interaction_time_unknown', 'followup_time_unknown'],
    });
  });
});
describe('B7-A 幂等 backfill service', () => {
  it('空库零新增', () => {
    const { db } = fixture();
    expect(runLegacyBackfill(db)).toMatchObject({
      totalJobs: 0, createdApplications: 0, createdEvents: 0, auditLogCreated: false,
    });
  });

  it('只迁移可靠流程，保留 Job/Profile/legacy 并生成 weak inferred seed', () => {
    const { db } = fixture();
    const jobs = new JobRepository(db);
    jobs.create({ id: 'not-contacted', company: '未投递公司' });
    jobs.create({ id: 'ambiguous-rejected', company: '模糊拒绝公司', communicationStatus: 'rejected' });
    jobs.create({
      id: 'replied', company: '可靠互动公司', city: '苏州', communicationStatus: 'replied',
      lastGreetedAt: 100, lastCommunicationNote: '真实私密备注', draftMessageText: '草稿内容',
    });
    jobs.create({
      id: 'paused-with-evidence', company: '暂停公司', communicationStatus: 'paused',
      followupCount: 1,
    });
    db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)')
      .run('default', '{"resumeText":"private"}', 1);
    db.prepare(`INSERT INTO import_logs (
      id, source, profile_count, job_count, ignored_key_count, warning_count, created_at, data_json
    ) VALUES ('existing-log', 'fixture', 0, 0, 0, 0, 1, '{}')`).run();
    const jobsBefore = db.prepare('SELECT id, data_json FROM jobs ORDER BY id').all() as Array<{ id: string; data_json: string }>;
    const profileBefore = db.prepare('SELECT * FROM profiles').all();

    const first = runLegacyBackfill(db, { now: () => 1_000 });
    expect(first).toMatchObject({
      totalJobs: 4,
      actions: { skip: 2, createApplication: 2, manualReview: 0 },
      createdApplications: 2,
      createdEvents: 2,
      auditLogCreated: true,
    });
    const applicationRows = db.prepare(
      'SELECT job_id, resume_version_id, origin, channel, market_city, migration_key FROM applications ORDER BY job_id',
    ).all() as Array<Record<string, unknown>>;
    expect(applicationRows).toHaveLength(2);
    expect(applicationRows.every((row) => (
      row.resume_version_id === null
      && row.origin === 'unknown'
      && row.channel === 'unknown'
      && row.market_city === null
      && String(row.migration_key).startsWith('v2:legacy-job:')
    ))).toBe(true);
    const events = new FeedbackEventRepository(db);
    const applications = new ApplicationRepository(db).listApplications();
    for (const application of applications) {
      const [event] = events.listEventsByApplication(application.id);
      expect(event).toMatchObject({
        eventType: 'legacy_status_imported', eventAt: null, timePrecision: 'unknown',
        actor: 'system', recordedBy: 'system_migration', sourceConfidence: 'inferred',
        evidenceLevel: 'weak', channel: 'unknown',
      });
      expect(projectApplication(application, event ? [event] : []).projectionStatus).not.toBe('invalid');
    }
    expect(db.prepare('SELECT id, data_json FROM jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(db.prepare('SELECT * FROM profiles').all()).toEqual(profileBefore);
    expect(jobs.get('replied')).toMatchObject({
      communicationStatus: 'replied', lastCommunicationNote: '真实私密备注', draftMessageText: '草稿内容',
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM applications WHERE job_id = 'not-contacted'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM applications WHERE job_id = 'ambiguous-rejected'").get())
      .toEqual({ count: 0 });
    const audit = db.prepare("SELECT data_json FROM import_logs WHERE source = 'job-memory-v2-backfill'").get() as { data_json: string };
    expect(audit.data_json).not.toContain('真实私密备注');
    expect(audit.data_json).not.toContain('可靠互动公司');

    const second = runLegacyBackfill(db, { now: () => 2_000 });
    expect(second).toMatchObject({
      createdApplications: 0, createdEvents: 0, alreadyMigrated: 2, auditLogCreated: false,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM import_logs WHERE source = 'job-memory-v2-backfill'").get())
      .toEqual({ count: 1 });
  });

  it('中途失败整体回滚且 Job hash 不变', () => {
    const { db } = fixture();
    const jobs = new JobRepository(db);
    jobs.create({ id: 'a', communicationStatus: 'replied' });
    jobs.create({ id: 'b', communicationStatus: 'interviewing' });
    const before = sha(JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all()));
    expect(() => runLegacyBackfill(db, {
      now: () => 1_000,
      failAfterCreatedApplications: 1,
    })).toThrow('B7-A_TEST_INJECTED_BACKFILL_FAILURE');
    expect(db.prepare('SELECT COUNT(*) AS count FROM applications').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM feedback_events').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM import_logs WHERE source = 'job-memory-v2-backfill'").get())
      .toEqual({ count: 0 });
    expect(sha(JSON.stringify(db.prepare('SELECT * FROM jobs ORDER BY id').all()))).toBe(before);
  });
});
