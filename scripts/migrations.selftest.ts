import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db';
import {
  CURRENT_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  MARKET_POSITION_SCHEMA_VERSION,
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
  // G2 能力基线新增 v3、G3 历史补录与漏斗新增 v4、G4 市场位置画像新增 v5；LATEST 与 PRODUCTION 有意区分。
  assert.equal(LATEST_SCHEMA_VERSION, 5);
  assert.equal(MARKET_POSITION_SCHEMA_VERSION, 5);
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
  // v2 → v3 升级：纯新增 G2 能力基线表，不破坏任何已有 v1/v2 业务数据。
  const CAPABILITY_TABLES = [
    'candidate_evidence',
    'capability_baseline_meta',
    'capability_baseline_proposals',
    'capability_baseline_versions',
    'capability_command_receipts',
  ] as const;
  const CAPABILITY_INDEXES = [
    'candidate_evidence_capability_idx',
    'capability_baseline_proposals_status_idx',
    'capability_baseline_versions_status_idx',
  ] as const;

  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 2 });
    seedV1BusinessData(db);
    const resumeId = insertResumeVersion(db, { id: 'resume-v3-upgrade' });
    const applicationId = insertApplication(db, { id: 'application-v3-upgrade', resumeVersionId: resumeId });
    insertFeedbackEvent(db, { id: 'event-v3-upgrade', applicationId });

    const v1DataBefore = readV1BusinessData(db);
    const jobMemoryBefore = {
      resumeVersions: db.prepare('SELECT * FROM resume_versions ORDER BY id').all(),
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all(),
      feedbackEvents: db.prepare('SELECT * FROM feedback_events ORDER BY id').all(),
    };
    for (const table of CAPABILITY_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }

    const result = initSchema(db, { targetVersion: 3 });
    assert.deepEqual(result, {
      currentVersion: 3,
      appliedVersions: [1, 2, 3],
      newlyAppliedVersions: [3],
    });
    assert.equal(schemaVersion(db), 3);
    assert.deepEqual(migrationRecords(db), [
      { version: 1, name: '001_v0_6_baseline' },
      { version: 2, name: '002_v0_7_job_memory_schema' },
      { version: 3, name: '003_v0_7_capability_baseline_schema' },
    ]);
    for (const table of CAPABILITY_TABLES) {
      assert.equal(tableNames(db).includes(table), true);
      assert.equal(rowCount(db, table), 0);
    }
    for (const index of CAPABILITY_INDEXES) {
      assert.equal(indexNames(db).includes(index), true);
    }

    // 所有已有 v1/v2 业务数据必须逐字节保留。
    assert.deepEqual(readV1BusinessData(db), v1DataBefore);
    assert.deepEqual(db.prepare('SELECT * FROM resume_versions ORDER BY id').all(), jobMemoryBefore.resumeVersions);
    assert.deepEqual(db.prepare('SELECT * FROM applications ORDER BY id').all(), jobMemoryBefore.applications);
    assert.deepEqual(db.prepare('SELECT * FROM feedback_events ORDER BY id').all(), jobMemoryBefore.feedbackEvents);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // 升级可重复执行且幂等。
    assert.deepEqual(initSchema(db, { targetVersion: 3 }).newlyAppliedVersions, []);
    assert.equal(schemaVersion(db), 3);

    // 默认 initSchema 仍停留在生产 v2，不会自动拉到 v3。
    assert.equal(PRODUCTION_SCHEMA_VERSION, 2);
  });

  // 默认 target（生产 v2）不会创建 G2 能力基线表。
  withTempDatabase((db) => {
    initSchema(db);
    assert.equal(schemaVersion(db), 2);
    for (const table of CAPABILITY_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }
  });

  // v3 → v4 升级：纯新增 G3 历史补录与漏斗草稿表，不破坏任何已有 v1/v2/v3 业务数据。
  const HISTORY_FUNNEL_TABLES = [
    'historical_import_sessions',
    'historical_baseline_drafts',
    'historical_event_drafts',
    'historical_import_receipts',
  ] as const;
  const HISTORY_FUNNEL_INDEXES = [
    'historical_baseline_drafts_session_idx',
    'historical_baseline_drafts_duplicate_idx',
    'historical_event_drafts_baseline_idx',
    'historical_import_receipts_session_idx',
  ] as const;

  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 3 });
    seedV1BusinessData(db);
    const resumeId = insertResumeVersion(db, { id: 'resume-v4-upgrade' });
    const applicationId = insertApplication(db, { id: 'application-v4-upgrade', resumeVersionId: resumeId });
    insertFeedbackEvent(db, { id: 'event-v4-upgrade', applicationId });

    const v1DataBefore = readV1BusinessData(db);
    const jobMemoryBefore = {
      resumeVersions: db.prepare('SELECT * FROM resume_versions ORDER BY id').all(),
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all(),
      feedbackEvents: db.prepare('SELECT * FROM feedback_events ORDER BY id').all(),
    };
    for (const table of HISTORY_FUNNEL_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }

    const result = initSchema(db, { targetVersion: 4 });
    assert.deepEqual(result, {
      currentVersion: 4,
      appliedVersions: [1, 2, 3, 4],
      newlyAppliedVersions: [4],
    });
    assert.equal(schemaVersion(db), 4);
    assert.deepEqual(migrationRecords(db), [
      { version: 1, name: '001_v0_6_baseline' },
      { version: 2, name: '002_v0_7_job_memory_schema' },
      { version: 3, name: '003_v0_7_capability_baseline_schema' },
      { version: 4, name: '004_v0_7_history_funnel_schema' },
    ]);
    for (const table of HISTORY_FUNNEL_TABLES) {
      assert.equal(tableNames(db).includes(table), true);
      assert.equal(rowCount(db, table), 0);
    }
    for (const index of HISTORY_FUNNEL_INDEXES) {
      assert.equal(indexNames(db).includes(index), true);
    }

    // 所有已有 v1/v2/v3 业务数据必须逐字节保留。
    assert.deepEqual(readV1BusinessData(db), v1DataBefore);
    assert.deepEqual(db.prepare('SELECT * FROM resume_versions ORDER BY id').all(), jobMemoryBefore.resumeVersions);
    assert.deepEqual(db.prepare('SELECT * FROM applications ORDER BY id').all(), jobMemoryBefore.applications);
    assert.deepEqual(db.prepare('SELECT * FROM feedback_events ORDER BY id').all(), jobMemoryBefore.feedbackEvents);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // 升级可重复执行且幂等。
    assert.deepEqual(initSchema(db, { targetVersion: 4 }).newlyAppliedVersions, []);
    assert.equal(schemaVersion(db), 4);

    // 默认 initSchema 仍停留在生产 v2，不会自动拉到 v4。
    assert.equal(PRODUCTION_SCHEMA_VERSION, 2);
  });

  // 默认 target（生产 v2）不会创建 G3 历史补录/漏斗表。
  withTempDatabase((db) => {
    initSchema(db);
    assert.equal(schemaVersion(db), 2);
    for (const table of HISTORY_FUNNEL_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }
  });

  // CHECK/FK 约束：历史补录草稿表。
  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 4 });
    seedV1BusinessData(db);

    const insertSession = (overrides: Partial<{
      id: string;
      status: string;
      createdAt: number;
      updatedAt: number;
      confirmedAt: number | null;
      discardedAt: number | null;
      rowVersion: number;
    }> = {}) => {
      const fixture = {
        id: nextId('session'),
        status: 'draft',
        createdAt: 200,
        updatedAt: 200,
        confirmedAt: null,
        discardedAt: null,
        rowVersion: 1,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO historical_import_sessions
          (id, status, created_at, updated_at, confirmed_at, discarded_at, row_version)
         VALUES (@id, @status, @createdAt, @updatedAt, @confirmedAt, @discardedAt, @rowVersion)`,
      ).run(fixture);
      return fixture.id;
    };

    const sessionId = insertSession();
    assert.equal(rowCount(db, 'historical_import_sessions'), 1);

    assertCheckViolation(() => insertSession({ status: 'invalid_status' }));
    assertCheckViolation(() => insertSession({ status: 'confirmed', confirmedAt: null }));
    assertCheckViolation(() =>
      insertSession({ status: 'confirmed', confirmedAt: 210, discardedAt: 210 }),
    );

    const insertBaselineDraft = (overrides: Partial<Record<string, unknown>> = {}) => {
      const id = (overrides.id as string) ?? nextId('baseline-draft');
      const fixture = {
        id,
        sessionId,
        company: '测试公司',
        role: '前端工程师',
        city: 'Suzhou',
        actuallyApplied: 1,
        appliedAt: 210,
        timePrecision: 'approximate',
        channel: 'boss',
        recruitingEntityKind: 'direct_employer',
        recruitingEntityName: null,
        contactName: null,
        resumeVersionId: null,
        highestKnownStage: null,
        sourceConfidence: 'recalled',
        evidenceLevel: 'weak',
        notes: null,
        duplicateOfDraftId: null,
        keepAsIndependentProcess: 0,
        independentProcessReason: null,
        createdJobId: null,
        createdApplicationId: null,
        createdAt: 210,
        updatedAt: 210,
        rowVersion: 1,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO historical_baseline_drafts (
          id, session_id, company, role, city, actually_applied, applied_at, time_precision,
          channel, recruiting_entity_kind, recruiting_entity_name, contact_name, resume_version_id,
          highest_known_stage, source_confidence, evidence_level, notes, duplicate_of_draft_id,
          keep_as_independent_process, independent_process_reason, created_job_id,
          created_application_id, created_at, updated_at, row_version
        ) VALUES (
          @id, @sessionId, @company, @role, @city, @actuallyApplied, @appliedAt, @timePrecision,
          @channel, @recruitingEntityKind, @recruitingEntityName, @contactName, @resumeVersionId,
          @highestKnownStage, @sourceConfidence, @evidenceLevel, @notes, @duplicateOfDraftId,
          @keepAsIndependentProcess, @independentProcessReason, @createdJobId,
          @createdApplicationId, @createdAt, @updatedAt, @rowVersion
        )`,
      ).run(fixture);
      return id;
    };

    const draftId = insertBaselineDraft();
    assert.equal(rowCount(db, 'historical_baseline_drafts'), 1);

    assertCheckViolation(() => insertBaselineDraft({ company: '   ' }));
    assertCheckViolation(() => insertBaselineDraft({ actuallyApplied: 2 }));
    assertCheckViolation(() =>
      insertBaselineDraft({ appliedAt: null, timePrecision: 'exact' }),
    );
    assertCheckViolation(() =>
      insertBaselineDraft({ keepAsIndependentProcess: 1, independentProcessReason: null }),
    );
    assertCheckViolation(() =>
      insertBaselineDraft({ keepAsIndependentProcess: 0, independentProcessReason: '不应存在' }),
    );
    assertCheckViolation(() =>
      insertBaselineDraft({ actuallyApplied: 0, createdApplicationId: 'application-v4-upgrade-fake' }),
    );
    assertCheckViolation(() => {
      const id = nextId('self-duplicate-draft');
      insertBaselineDraft({ id, duplicateOfDraftId: id });
    });
    assertForeignKeyViolation(() => insertBaselineDraft({ sessionId: 'session-missing' }));

    const insertEventDraft = (overrides: Partial<Record<string, unknown>> = {}) => {
      const id = (overrides.id as string) ?? nextId('event-draft');
      const fixture = {
        id,
        baselineDraftId: draftId,
        eventType: 'applied',
        eventAt: 210,
        timePrecision: 'approximate',
        actor: 'user',
        sourceConfidence: 'recalled',
        evidenceLevel: 'weak',
        channel: 'boss',
        reasonCode: null,
        note: null,
        createdFeedbackEventId: null,
        createdAt: 210,
        updatedAt: 210,
        rowVersion: 1,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO historical_event_drafts (
          id, baseline_draft_id, event_type, event_at, time_precision, actor, source_confidence,
          evidence_level, channel, reason_code, note, created_feedback_event_id, created_at,
          updated_at, row_version
        ) VALUES (
          @id, @baselineDraftId, @eventType, @eventAt, @timePrecision, @actor, @sourceConfidence,
          @evidenceLevel, @channel, @reasonCode, @note, @createdFeedbackEventId, @createdAt,
          @updatedAt, @rowVersion
        )`,
      ).run(fixture);
      return id;
    };

    insertEventDraft();
    assert.equal(rowCount(db, 'historical_event_drafts'), 1);
    assertCheckViolation(() => insertEventDraft({ eventType: 'invalid_event' }));
    assertCheckViolation(() => insertEventDraft({ eventAt: null, timePrecision: 'exact' }));
    assertForeignKeyViolation(() => insertEventDraft({ baselineDraftId: 'draft-missing' }));

    db.prepare(
      `INSERT INTO historical_import_receipts (idempotency_key, session_id, request_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('receipt-key-1', sessionId, 'hash-1', '{"ok":true}', 220);
    assert.equal(rowCount(db, 'historical_import_receipts'), 1);
    assertForeignKeyViolation(() =>
      db
        .prepare(
          `INSERT INTO historical_import_receipts (idempotency_key, session_id, request_hash, result_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('receipt-key-2', 'session-missing', 'hash-2', '{}', 221),
    );

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });

  // v4 → v5 升级：纯新增 G4 市场位置画像表，不破坏任何已有 v1/v2/v3/v4 业务数据。
  const MARKET_POSITION_TABLES = [
    'market_position_meta',
    'market_position_proposals',
    'market_position_versions',
    'market_position_receipts',
  ] as const;
  const MARKET_POSITION_INDEXES = [
    'market_position_proposals_status_idx',
    'market_position_versions_status_idx',
  ] as const;

  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 4 });
    seedV1BusinessData(db);
    const resumeId = insertResumeVersion(db, { id: 'resume-v5-upgrade' });
    const applicationId = insertApplication(db, { id: 'application-v5-upgrade', resumeVersionId: resumeId });
    insertFeedbackEvent(db, { id: 'event-v5-upgrade', applicationId });

    const v1DataBefore = readV1BusinessData(db);
    const jobMemoryBefore = {
      resumeVersions: db.prepare('SELECT * FROM resume_versions ORDER BY id').all(),
      applications: db.prepare('SELECT * FROM applications ORDER BY id').all(),
      feedbackEvents: db.prepare('SELECT * FROM feedback_events ORDER BY id').all(),
    };
    for (const table of MARKET_POSITION_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }

    const result = initSchema(db, { targetVersion: 5 });
    assert.deepEqual(result, {
      currentVersion: 5,
      appliedVersions: [1, 2, 3, 4, 5],
      newlyAppliedVersions: [5],
    });
    assert.equal(schemaVersion(db), 5);
    assert.deepEqual(migrationRecords(db), [
      { version: 1, name: '001_v0_6_baseline' },
      { version: 2, name: '002_v0_7_job_memory_schema' },
      { version: 3, name: '003_v0_7_capability_baseline_schema' },
      { version: 4, name: '004_v0_7_history_funnel_schema' },
      { version: 5, name: '005_v0_7_market_position_schema' },
    ]);
    for (const table of MARKET_POSITION_TABLES) {
      assert.equal(tableNames(db).includes(table), true);
      assert.equal(rowCount(db, table), 0);
    }
    for (const index of MARKET_POSITION_INDEXES) {
      assert.equal(indexNames(db).includes(index), true);
    }

    // 所有已有 v1/v2/v3/v4 业务数据必须逐字节保留。
    assert.deepEqual(readV1BusinessData(db), v1DataBefore);
    assert.deepEqual(db.prepare('SELECT * FROM resume_versions ORDER BY id').all(), jobMemoryBefore.resumeVersions);
    assert.deepEqual(db.prepare('SELECT * FROM applications ORDER BY id').all(), jobMemoryBefore.applications);
    assert.deepEqual(db.prepare('SELECT * FROM feedback_events ORDER BY id').all(), jobMemoryBefore.feedbackEvents);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // 升级可重复执行且幂等。
    assert.deepEqual(initSchema(db, { targetVersion: 5 }).newlyAppliedVersions, []);
    assert.equal(schemaVersion(db), 5);

    // 默认 initSchema 仍停留在生产 v2，不会自动拉到 v5。
    assert.equal(PRODUCTION_SCHEMA_VERSION, 2);
  });

  // 默认 target（生产 v2）不会创建 G4 市场位置画像表。
  withTempDatabase((db) => {
    initSchema(db);
    assert.equal(schemaVersion(db), 2);
    for (const table of MARKET_POSITION_TABLES) {
      assert.equal(tableNames(db).includes(table), false);
    }
  });

  // CHECK/FK 约束：市场位置画像提案 / 正式版本 / 命令回执表。
  withTempDatabase((db) => {
    initSchema(db, { targetVersion: 5 });
    seedV1BusinessData(db);

    db.prepare(
      `INSERT INTO market_position_meta (id, state_version, active_version_id, updated_at)
       VALUES ('default', 0, NULL, 300)`,
    ).run();
    assert.equal(rowCount(db, 'market_position_meta'), 1);
    assertCheckViolation(() =>
      db
        .prepare(
          `INSERT INTO market_position_meta (id, state_version, active_version_id, updated_at)
           VALUES ('not-default', 0, NULL, 300)`,
        )
        .run(),
    );
    assertCheckViolation(() =>
      db
        .prepare(
          `UPDATE market_position_meta SET state_version = -1 WHERE id = 'default'`,
        )
        .run(),
    );

    const insertProposal = (overrides: Partial<Record<string, unknown>> = {}) => {
      const id = (overrides.id as string) ?? nextId('mp-proposal');
      const fixture = {
        id,
        status: 'proposed',
        generatedBy: 'manual',
        inputFingerprint: `fingerprint-${id}`,
        dataJson: '{}',
        createdAt: 300,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO market_position_proposals
          (id, status, generated_by, input_fingerprint, data_json, created_at)
         VALUES (@id, @status, @generatedBy, @inputFingerprint, @dataJson, @createdAt)`,
      ).run(fixture);
      return id;
    };

    const proposalId = insertProposal();
    assert.equal(rowCount(db, 'market_position_proposals'), 1);
    assertCheckViolation(() => insertProposal({ status: 'invalid_status' }));
    assertCheckViolation(() => insertProposal({ generatedBy: 'invalid_source' }));
    assertCheckViolation(() => insertProposal({ inputFingerprint: '   ' }));

    const insertVersion = (overrides: Partial<Record<string, unknown>> = {}) => {
      const id = (overrides.id as string) ?? nextId('mp-version');
      const fixture = {
        id,
        version: 1,
        status: 'active',
        proposalId,
        dataJson: '{}',
        createdAt: 300,
        activatedAt: 300,
        ...overrides,
      };
      db.prepare(
        `INSERT INTO market_position_versions
          (id, version, status, proposal_id, data_json, created_at, activated_at)
         VALUES (@id, @version, @status, @proposalId, @dataJson, @createdAt, @activatedAt)`,
      ).run(fixture);
      return id;
    };

    insertVersion();
    assert.equal(rowCount(db, 'market_position_versions'), 1);
    assertCheckViolation(() => insertVersion({ version: 0 }));
    assertCheckViolation(() => insertVersion({ status: 'invalid_status' }));
    assertCheckViolation(() => insertVersion({ proposalId: '   ' }));

    db.prepare(
      `INSERT INTO market_position_receipts
        (idempotency_key, command_type, target_id, result_id, request_hash, created_at)
       VALUES ('mp-receipt-1', 'manual_proposal', NULL, ?, 'hash-1', 300)`,
    ).run(proposalId);
    assert.equal(rowCount(db, 'market_position_receipts'), 1);
    assertCheckViolation(() =>
      db
        .prepare(
          `INSERT INTO market_position_receipts
            (idempotency_key, command_type, target_id, result_id, request_hash, created_at)
           VALUES ('mp-receipt-2', 'invalid_command', NULL, NULL, 'hash-2', 300)`,
        )
        .run(),
    );
    assertCheckViolation(() =>
      db
        .prepare(
          `INSERT INTO market_position_receipts
            (idempotency_key, command_type, target_id, result_id, request_hash, created_at)
           VALUES ('   ', 'manual_proposal', NULL, NULL, 'hash-3', 300)`,
        )
        .run(),
    );

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

assert.equal(fs.existsSync(tempDir), false);
console.log('migrations.selftest: passed');
