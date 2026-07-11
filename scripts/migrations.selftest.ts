import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../server/schema';
import {
  runMigrations,
  SCHEMA_MIGRATIONS,
  type SchemaMigration,
} from '../server/migrations';

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

function migrationRecords(db: Database.Database): Array<{ version: number; name: string }> {
  return db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
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

// Scenario 1: a fresh database initializes from zero and repeated initialization is a no-op.
{
  const db = new Database(':memory:');
  try {
    initSchema(db);
    assert.deepEqual(tableNames(db), [
      'app_meta',
      'import_logs',
      'jobs',
      'profiles',
      'schema_migrations',
    ]);
    assert.deepEqual(migrationRecords(db), [{ version: 1, name: '001_v0_6_baseline' }]);
    const metaBefore = db
      .prepare("SELECT value, updated_at FROM app_meta WHERE key = 'schema_version'")
      .get();
    initSchema(db);
    assert.deepEqual(migrationRecords(db), [{ version: 1, name: '001_v0_6_baseline' }]);
    assert.deepEqual(
      db.prepare("SELECT value, updated_at FROM app_meta WHERE key = 'schema_version'").get(),
      metaBefore,
    );
  } finally {
    db.close();
  }
}

// Scenario 2: a v0.6.1-style four-table database is baselined without data loss.
{
  const db = new Database(':memory:');
  try {
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
      INSERT INTO jobs VALUES ('legacy-job', 'Legacy', 'FE', 'Suzhou', '20K', 80, 'not_contacted', 102, 100, '{"id":"legacy-job"}');
      INSERT INTO import_logs VALUES ('legacy-log', 'backup', 1, 1, 0, 0, 103, '{"id":"legacy-log"}');
    `);

    const result = runMigrations(db);
    assert.deepEqual(result.newlyAppliedVersions, [1]);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM profiles').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM import_logs').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (db.prepare("SELECT company FROM jobs WHERE id = 'legacy-job'").get() as { company: string })
        .company,
      'Legacy',
    );
    assert.deepEqual(runMigrations(db).newlyAppliedVersions, []);
  } finally {
    db.close();
  }
}

// Scenario 3: a failed migration rolls back both its SQL and completion record, then can retry.
{
  const db = new Database(':memory:');
  try {
    initSchema(db);
    const failing = makeMigration(
      2,
      '002_failure_probe',
      'CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);',
    );
    assert.throws(() => runMigrations(db, [...SCHEMA_MIGRATIONS, failing]), /missing_table/);
    assert.equal(tableNames(db).includes('rollback_probe'), false);
    assert.deepEqual(migrationRecords(db), [{ version: 1, name: '001_v0_6_baseline' }]);

    const repaired = makeMigration(
      2,
      '002_failure_probe',
      'CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY);',
    );
    const retry = runMigrations(db, [...SCHEMA_MIGRATIONS, repaired]);
    assert.deepEqual(retry.newlyAppliedVersions, [2]);
    assert.equal(tableNames(db).includes('rollback_probe'), true);
  } finally {
    db.close();
  }
}

// Scenario 4: duplicate, unordered, gapped and conflicting versions are rejected explicitly.
{
  const db = new Database(':memory:');
  try {
    assert.throws(
      () => runMigrations(db, [makeMigration(1, 'one'), makeMigration(1, 'duplicate')]),
      /contiguous and ordered/,
    );
    assert.throws(
      () => runMigrations(db, [makeMigration(2, 'two'), makeMigration(1, 'one')]),
      /contiguous and ordered/,
    );
    assert.throws(
      () => runMigrations(db, [makeMigration(1, 'one'), makeMigration(3, 'three')]),
      /contiguous and ordered/,
    );

    initSchema(db);
    db.prepare('UPDATE schema_migrations SET name = ? WHERE version = 1').run('conflict');
    assert.throws(() => initSchema(db), /name conflict/);
  } finally {
    db.close();
  }
}

console.log('migrations.selftest: passed');
