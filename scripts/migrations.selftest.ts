import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db';
import {
  CURRENT_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
  runMigrations,
  SCHEMA_MIGRATIONS,
  type SchemaMigration,
} from '../server/migrations';
import { JOB_MEMORY_SCHEMA_V2_SQL } from '../server/migrations/jobMemorySchemaV2';
import { initSchema } from '../server/schema';
import { SNAPSHOT_SCHEMA_VERSION, SYNC_TABLES } from '../server/sync/types';

const JOB_MEMORY_TABLES = ['applications', 'feedback_events', 'resume_versions'] as const;
const JOB_MEMORY_INDEXES = [
  'applications_job_idx',
  'applications_market_idx',
  'applications_resume_idx',
  'applications_superseded_idx',
  'feedback_events_application_time_idx',
  'feedback_events_reason_idx',
  'feedback_events_target_idx',
] as const;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-migrations-'));
let databaseSequence = 0;
let fixtureSequence = 0;

function withTempDatabase(run: (db: Database.Database, dbPath: string) => void): void {
  databaseSequence += 1;
  const dbPath = path.join(tempDir, `scenario-${databaseSequence}.sqlite3`);
  const db = openDb(dbPath);
  try {
    assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1);
    run(db, dbPath);
  } finally {
    db.close();
  }
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function migrationRecords(db: Database.Database): Array<{ version: number; name: string }> {
  return db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
}

function schemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
    .get() as { value: string };
  return Number(row.value);
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function makeMigration(version: number, name: string, sql = 'SELECT 1'): SchemaMigration {
  return {
    version,
    name,
    up(db) {
      db.exec(sql);
    },
  };
}

function nextId(prefix: string): string {
  fixtureSequence += 1;
  return `${prefix}-${fixtureSequence}`;
}

function seedV1BusinessData(db: Database.Database): void {
  db.prepare('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
    'fixture_meta',
    'preserve-me',
    101,
  );
  db.prepare('INSERT INTO profiles (id, data_json, updated_at) VALUES (?, ?, ?)').run(
    'default',
    '{"targetRole":"frontend","resumeText":"exact bytes"}',
    102,
  );
  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, company, role, city, salary_range, match_score,
      communication_status, updated_at, created_at, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertJob.run(
    'job-a',
    'Alpha',
    'Frontend',
    'Suzhou',
    '20K',
    80,
    'not_contacted',
    103,
    100,
    '{"id":"job-a","communicationStatus":"not_contacted","note":"A"}',
  );
  insertJob.run(
    'job-b',
    'Beta',
    'Senior Frontend',
    'Shanghai',
    '30K',
    90,
    'replied',
    104,
    100,
    '{"id":"job-b","communicationStatus":"replied","note":"B"}',
  );
  db.prepare(
    `INSERT INTO import_logs (
      id, source, profile_count, job_count, ignored_key_count,
      warning_count, created_at, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('fixture-log', 'fixture', 1, 2, 0, 0, 105, '{"id":"fixture-log"}');
}

function readV1BusinessData(db: Database.Database): Record<string, unknown[]> {
  return {
    profiles: db.prepare('SELECT * FROM profiles ORDER BY id').all(),
    jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
    importLogs: db.prepare('SELECT * FROM import_logs ORDER BY id').all(),
    appMetaWithoutVersion: db
      .prepare("SELECT * FROM app_meta WHERE key <> 'schema_version' ORDER BY key")
      .all(),
  };
}

const INSERT_RESUME_VERSION_SQL = `
  INSERT INTO resume_versions (
    id, name, source, content_hash, summary, content_json,
    created_at, archived_at, row_version, idempotency_key, request_hash
  ) VALUES (
    @id, @name, @source, @contentHash, @summary, @contentJson,
    @createdAt, @archivedAt, @rowVersion, @idempotencyKey, @requestHash
  )
`;

interface ResumeVersionFixture {
  id: string;
  name: string;
  source: string;
  contentHash: string;
  summary: string;
  contentJson: string;
  createdAt: number;
  archivedAt: number | null;
  rowVersion: number;
  idempotencyKey: string;
  requestHash: string;
}

function insertResumeVersion(
  db: Database.Database,
  overrides: Partial<ResumeVersionFixture> = {},
): string {
  const id = overrides.id ?? nextId('resume');
  const fixture: ResumeVersionFixture = {
    name: '默认简历',
    source: 'pasted_text',
    contentHash: `content-hash-${id}`,
    summary: '',
    contentJson: '{"resumeText":"resume","projectExperience":"project"}',
    createdAt: 100,
    archivedAt: null,
    rowVersion: 1,
    idempotencyKey: `resume-key-${id}`,
    requestHash: `resume-request-${id}`,
    ...overrides,
    id,
  };
  db.prepare(INSERT_RESUME_VERSION_SQL).run(fixture);
  return id;
}

const INSERT_APPLICATION_SQL = `
  INSERT INTO applications (
    id, job_id, resume_version_id, origin, channel, channel_other_label,
    job_city_snapshot, market_city, work_mode, recruiting_entity_kind,
    recruiting_entity_name, employer_group_key, end_client_name,
    primary_contact_json, draft_message_text, created_at, updated_at,
    voided_at, void_reason, superseded_by_application_id, row_version,
    idempotency_key, request_hash, migration_key
  ) VALUES (
    @id, @jobId, @resumeVersionId, @origin, @channel, @channelOtherLabel,
    @jobCitySnapshot, @marketCity, @workMode, @recruitingEntityKind,
    @recruitingEntityName, @employerGroupKey, @endClientName,
    @primaryContactJson, @draftMessageText, @createdAt, @updatedAt,
    @voidedAt, @voidReason, @supersededByApplicationId, @rowVersion,
    @idempotencyKey, @requestHash, @migrationKey
  )
`;

interface ApplicationFixture {
  id: string;
  jobId: string;
  resumeVersionId: string | null;
  origin: string;
  channel: string;
  channelOtherLabel: string | null;
  jobCitySnapshot: string | null;
  marketCity: string | null;
  workMode: string;
  recruitingEntityKind: string;
  recruitingEntityName: string | null;
  employerGroupKey: string | null;
  endClientName: string | null;
  primaryContactJson: string | null;
  draftMessageText: string | null;
  createdAt: number;
  updatedAt: number;
  voidedAt: number | null;
  voidReason: string | null;
  supersededByApplicationId: string | null;
  rowVersion: number;
  idempotencyKey: string;
  requestHash: string;
  migrationKey: string | null;
}

function insertApplication(
  db: Database.Database,
  overrides: Partial<ApplicationFixture> = {},
): string {
  const id = overrides.id ?? nextId('application');
  const fixture: ApplicationFixture = {
    jobId: 'job-a',
    resumeVersionId: null,
    origin: 'outbound',
    channel: 'boss',
    channelOtherLabel: null,
    jobCitySnapshot: 'Suzhou',
    marketCity: 'Suzhou',
    workMode: 'onsite',
    recruitingEntityKind: 'direct_employer',
    recruitingEntityName: 'Alpha',
    employerGroupKey: null,
    endClientName: null,
    primaryContactJson: null,
    draftMessageText: null,
    createdAt: 110,
    updatedAt: 110,
    voidedAt: null,
    voidReason: null,
    supersededByApplicationId: null,
    rowVersion: 1,
    idempotencyKey: `application-key-${id}`,
    requestHash: `application-request-${id}`,
    migrationKey: null,
    ...overrides,
    id,
  };
  db.prepare(INSERT_APPLICATION_SQL).run(fixture);
  return id;
}

const INSERT_FEEDBACK_EVENT_SQL = `
  INSERT INTO feedback_events (
    id, application_id, event_type, event_at, time_precision, actor,
    recorded_by, source_confidence, evidence_level, channel, note,
    reason_code, payload_json, target_event_id, idempotency_key,
    request_hash, created_at
  ) VALUES (
    @id, @applicationId, @eventType, @eventAt, @timePrecision, @actor,
    @recordedBy, @sourceConfidence, @evidenceLevel, @channel, @note,
    @reasonCode, @payloadJson, @targetEventId, @idempotencyKey,
    @requestHash, @createdAt
  )
`;

interface FeedbackEventFixture {
  id: string;
  applicationId: string;
  eventType: string;
  eventAt: number | null;
  timePrecision: string;
  actor: string;
  recordedBy: string;
  sourceConfidence: string;
  evidenceLevel: string;
  channel: string | null;
  note: string | null;
  reasonCode: string | null;
  payloadJson: string;
  targetEventId: string | null;
  idempotencyKey: string;
  requestHash: string;
  createdAt: number;
}

function insertFeedbackEvent(
  db: Database.Database,
  overrides: Partial<FeedbackEventFixture> = {},
): string {
  const id = overrides.id ?? nextId('event');
  const fixture: FeedbackEventFixture = {
    applicationId: 'application-missing',
    eventType: 'application_created',
    eventAt: 110,
    timePrecision: 'exact',
    actor: 'user',
    recordedBy: 'user',
    sourceConfidence: 'exact',
    evidenceLevel: 'strong',
    channel: 'boss',
    note: null,
    reasonCode: null,
    payloadJson: '{}',
    targetEventId: null,
    idempotencyKey: `event-key-${id}`,
    requestHash: `event-request-${id}`,
    createdAt: 110,
    ...overrides,
    id,
  };
  db.prepare(INSERT_FEEDBACK_EVENT_SQL).run(fixture);
  return id;
}

function assertCheckViolation(action: () => void): void {
  assert.throws(action, /CHECK constraint failed/);
}

function assertForeignKeyViolation(action: () => void): void {
  assert.throws(action, /FOREIGN KEY constraint failed/);
}

try {
  assert.equal(PRODUCTION_SCHEMA_VERSION, 2);
  assert.equal(CURRENT_SCHEMA_VERSION, PRODUCTION_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 2);
  assert.equal(SCHEMA_MIGRATIONS.at(-1)?.version, LATEST_SCHEMA_VERSION);
  assert.equal(SCHEMA_MIGRATIONS.length, LATEST_SCHEMA_VERSION);
  assert.equal(SNAPSHOT_SCHEMA_VERSION, 2);
  assert.deepEqual([...SYNC_TABLES], [
    'profiles', 'jobs', 'resume_versions', 'applications',
    'feedback_events', 'import_logs', 'app_meta',
  ]);
  assert.doesNotMatch(
    JOB_MEMORY_SCHEMA_V2_SQL,
    /\b(?:INSERT\s+INTO|UPDATE\s+jobs|DELETE\s+FROM)\b/i,
  );
  assert.doesNotMatch(JOB_MEMORY_SCHEMA_V2_SQL, /communication_status/i);

  // B7-B 后默认初始化到生产 v2 target，并保持幂等。
  withTempDatabase((db) => {
    const first = initSchema(db);
    assert.deepEqual(first, {
      currentVersion: 2,
      appliedVersions: [1, 2],
      newlyAppliedVersions: [1, 2],
    });
    assert.deepEqual(tableNames(db), [
      'app_meta',
      'applications',
      'feedback_events',
      'import_logs',
      'jobs',
      'profiles',
      'resume_versions',
      'schema_migrations',
    ]);
    assert.equal(JOB_MEMORY_TABLES.every((table) => tableNames(db).includes(table)), true);
    assert.deepEqual(migrationRecords(db), [
      { version: 1, name: '001_v0_6_baseline' },
      { version: 2, name: '002_v0_7_job_memory_schema' },
    ]);
    const metaBefore = db
      .prepare("SELECT value, updated_at FROM app_meta WHERE key = 'schema_version'")
      .get();
    assert.deepEqual(initSchema(db).newlyAppliedVersions, []);
    assert.deepEqual(
      db.prepare("SELECT value, updated_at FROM app_meta WHERE key = 'schema_version'").get(),
      metaBefore,
    );
  });

  // A pre-runner v0.6.x database is baselined at v1 without changing its rows.
  withTempDatabase((db) => {
    db.exec(`
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE profiles (id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, company TEXT, role TEXT, city TEXT, salary_range TEXT,
        match_score INTEGER, communication_status TEXT, updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE import_logs (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, profile_count INTEGER NOT NULL,
        job_count INTEGER NOT NULL, ignored_key_count INTEGER NOT NULL,
        warning_count INTEGER NOT NULL, created_at INTEGER NOT NULL, data_json TEXT NOT NULL
      );
      INSERT INTO app_meta VALUES ('schema_version', '1', 100);
      INSERT INTO profiles VALUES ('default', '{"targetRole":"frontend"}', 101);
      INSERT INTO jobs VALUES (
        'legacy-job', 'Legacy', 'FE', 'Suzhou', '20K', 80,
        'not_contacted', 102, 100, '{"id":"legacy-job"}'
      );
      INSERT INTO import_logs VALUES (
        'legacy-log', 'backup', 1, 1, 0, 0, 103, '{"id":"legacy-log"}'
      );
    `);
    const before = readV1BusinessData(db);
    assert.deepEqual(initSchema(db, { targetVersion: 1 }).newlyAppliedVersions, [1]);
    assert.equal(schemaVersion(db), 1);
    assert.deepEqual(readV1BusinessData(db), before);
    assert.equal(JOB_MEMORY_TABLES.some((table) => tableNames(db).includes(table)), false);
  });

  // A v1 database with real-shaped legacy rows upgrades to empty v2 tables without rewrites.
  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 1 });
    seedV1BusinessData(db);
    const v1DataBefore = readV1BusinessData(db);
    const jobsDataJsonBefore = db
      .prepare('SELECT id, data_json, communication_status FROM jobs ORDER BY id')
      .all();

    const result = initSchema(db, { targetVersion: 2 });
    assert.deepEqual(result, {
      currentVersion: 2,
      appliedVersions: [1, 2],
      newlyAppliedVersions: [2],
    });
    assert.equal(schemaVersion(db), 2);
    assert.deepEqual(migrationRecords(db), [
      { version: 1, name: '001_v0_6_baseline' },
      { version: 2, name: '002_v0_7_job_memory_schema' },
    ]);
    for (const table of JOB_MEMORY_TABLES) {
      assert.equal(tableNames(db).includes(table), true);
      assert.equal(rowCount(db, table), 0);
    }
    for (const index of JOB_MEMORY_INDEXES) {
      assert.equal(indexNames(db).includes(index), true);
    }
    assert.deepEqual(readV1BusinessData(db), v1DataBefore);
    assert.deepEqual(
      db.prepare('SELECT id, data_json, communication_status FROM jobs ORDER BY id').all(),
      jobsDataJsonBefore,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    const tablesAfterFirstRun = tableNames(db);
    const indexesAfterFirstRun = indexNames(db);
    const v1DataAfterFirstRun = readV1BusinessData(db);
    assert.deepEqual(initSchema(db, { targetVersion: 2 }).newlyAppliedVersions, []);
    assert.equal(schemaVersion(db), 2);
    assert.deepEqual(tableNames(db), tablesAfterFirstRun);
    assert.deepEqual(indexNames(db), indexesAfterFirstRun);
    assert.equal(new Set(indexesAfterFirstRun).size, indexesAfterFirstRun.length);
    assert.deepEqual(readV1BusinessData(db), v1DataAfterFirstRun);
    for (const table of JOB_MEMORY_TABLES) {
      assert.equal(rowCount(db, table), 0);
    }
    assert.deepEqual(initSchema(db).newlyAppliedVersions, []);
  });

  // A target newer than the registry fails before any migration table is created.
  withTempDatabase((db) => {
    assert.throws(
      () => initSchema(db, { targetVersion: LATEST_SCHEMA_VERSION + 1 }),
      /newer than the latest known migration/,
    );
    assert.deepEqual(tableNames(db), []);
  });

  // The actual v2 migration SQL is transactionally rolled back when failure is injected after up().
  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 1 });
    seedV1BusinessData(db);
    const v1DataBefore = readV1BusinessData(db);
    const officialV2 = SCHEMA_MIGRATIONS[1];
    assert.ok(officialV2);
    const failingV2: SchemaMigration = {
      ...officialV2,
      up(database) {
        officialV2.up(database);
        throw new Error('v2 rollback probe');
      },
    };
    assert.throws(
      () =>
        runMigrations(db, {
          migrations: [SCHEMA_MIGRATIONS[0]!, failingV2],
          targetVersion: 2,
        }),
      /v2 rollback probe/,
    );
    assert.equal(schemaVersion(db), 1);
    assert.deepEqual(migrationRecords(db), [{ version: 1, name: '001_v0_6_baseline' }]);
    assert.equal(JOB_MEMORY_TABLES.some((table) => tableNames(db).includes(table)), false);
    assert.deepEqual(readV1BusinessData(db), v1DataBefore);

    assert.deepEqual(initSchema(db, { targetVersion: 2 }).newlyAppliedVersions, [2]);
    assert.equal(schemaVersion(db), 2);
  });

  // Duplicate, unordered, gapped and conflicting migration registries fail explicitly.
  withTempDatabase((db) => {
    assert.throws(
      () =>
        runMigrations(db, {
          migrations: [makeMigration(1, 'one'), makeMigration(1, 'duplicate')],
          targetVersion: 1,
        }),
      /contiguous and ordered/,
    );
    assert.throws(
      () =>
        runMigrations(db, {
          migrations: [makeMigration(2, 'two'), makeMigration(1, 'one')],
          targetVersion: 1,
        }),
      /contiguous and ordered/,
    );
    assert.throws(
      () =>
        runMigrations(db, {
          migrations: [makeMigration(1, 'one'), makeMigration(3, 'three')],
          targetVersion: 1,
        }),
      /contiguous and ordered/,
    );

    initSchema(db, { targetVersion: 1 });
    db.prepare('UPDATE schema_migrations SET name = ? WHERE version = 1').run('conflict');
    assert.throws(() => initSchema(db, { targetVersion: 1 }), /name conflict/);
  });

  // CHECK constraints, legal minimum rows, FK enforcement and RESTRICT deletion.
  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 2 });
    seedV1BusinessData(db);

    const resumeId = insertResumeVersion(db, { id: 'resume-valid' });
    const applicationId = insertApplication(db, {
      id: 'application-valid',
      resumeVersionId: resumeId,
    });
    const ordinaryEventId = insertFeedbackEvent(db, {
      id: 'event-valid',
      applicationId,
    });
    insertFeedbackEvent(db, {
      id: 'event-void-valid',
      applicationId,
      eventType: 'event_voided',
      eventAt: 120,
      payloadJson:
        '{"targetEventId":"event-valid","targetEventType":"application_created","reason":"纠正误录"}',
      targetEventId: ordinaryEventId,
      createdAt: 120,
    });
    assert.equal(rowCount(db, 'resume_versions'), 1);
    assert.equal(rowCount(db, 'applications'), 1);
    assert.equal(rowCount(db, 'feedback_events'), 2);

    assertCheckViolation(() => insertResumeVersion(db, { source: 'invalid_source' }));
    assertCheckViolation(() => insertResumeVersion(db, { idempotencyKey: '   ' }));
    assertCheckViolation(() => insertResumeVersion(db, { rowVersion: 0 }));
    assertCheckViolation(() =>
      insertResumeVersion(db, { createdAt: 100, archivedAt: 99 }),
    );
    assertCheckViolation(() => insertApplication(db, { origin: 'invalid_origin' }));
    assertCheckViolation(() =>
      insertApplication(db, { channel: 'other', channelOtherLabel: null }),
    );
    assertCheckViolation(() =>
      insertApplication(db, { channel: 'boss', channelOtherLabel: '不应存在' }),
    );
    assertCheckViolation(() =>
      insertApplication(db, { createdAt: 110, voidedAt: 120, voidReason: null }),
    );
    assertCheckViolation(() =>
      insertApplication(db, { createdAt: 110, updatedAt: 109 }),
    );
    assertCheckViolation(() => insertApplication(db, { rowVersion: 0 }));
    assertCheckViolation(() => insertApplication(db, { idempotencyKey: '' }));
    assertCheckViolation(() => {
      const id = nextId('self-superseded-application');
      insertApplication(db, { id, supersededByApplicationId: id });
    });
    assertCheckViolation(() =>
      insertFeedbackEvent(db, { applicationId, eventType: 'invalid_event' }),
    );
    assertCheckViolation(() =>
      insertFeedbackEvent(db, {
        applicationId,
        eventType: 'event_voided',
        targetEventId: null,
      }),
    );
    assertCheckViolation(() =>
      insertFeedbackEvent(db, { applicationId, targetEventId: ordinaryEventId }),
    );
    assertCheckViolation(() => {
      const id = nextId('self-target-event');
      insertFeedbackEvent(db, {
        id,
        applicationId,
        eventType: 'event_voided',
        targetEventId: id,
      });
    });
    assertCheckViolation(() =>
      insertFeedbackEvent(db, { applicationId, eventAt: null, timePrecision: 'exact' }),
    );
    assertCheckViolation(() =>
      insertFeedbackEvent(db, { applicationId, idempotencyKey: ' ' }),
    );

    assertForeignKeyViolation(() =>
      insertApplication(db, { jobId: 'job-missing', resumeVersionId: resumeId }),
    );
    assertForeignKeyViolation(() =>
      insertApplication(db, { resumeVersionId: 'resume-missing' }),
    );
    assertForeignKeyViolation(() =>
      insertFeedbackEvent(db, { applicationId: 'application-missing' }),
    );
    assertForeignKeyViolation(() =>
      insertFeedbackEvent(db, {
        applicationId,
        eventType: 'event_voided',
        targetEventId: 'event-missing',
      }),
    );
    assertForeignKeyViolation(() => {
      db.prepare("DELETE FROM jobs WHERE id = 'job-a'").run();
    });
    assertForeignKeyViolation(() => {
      db.prepare('DELETE FROM resume_versions WHERE id = ?').run(resumeId);
    });
    assertForeignKeyViolation(() => {
      db.prepare('DELETE FROM applications WHERE id = ?').run(applicationId);
    });
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(rowCount(db, 'resume_versions'), 1);
    assert.equal(rowCount(db, 'applications'), 1);
    assert.equal(rowCount(db, 'feedback_events'), 2);
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.equal(fs.existsSync(tempDir), false);
console.log('migrations.selftest: passed');
