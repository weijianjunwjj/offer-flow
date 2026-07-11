import type { SqliteDatabase } from './db';

export interface SchemaMigration {
  version: number;
  name: string;
  up(db: SqliteDatabase): void;
}

export interface MigrationRunResult {
  currentVersion: number;
  appliedVersions: number[];
  newlyAppliedVersions: number[];
}

export const CURRENT_SCHEMA_VERSION = 1;

const BASELINE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company TEXT,
  role TEXT,
  city TEXT,
  salary_range TEXT,
  match_score INTEGER,
  communication_status TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_logs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  profile_count INTEGER NOT NULL,
  job_count INTEGER NOT NULL,
  ignored_key_count INTEGER NOT NULL,
  warning_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  data_json TEXT NOT NULL
);
`;

export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    name: '001_v0_6_baseline',
    up(db) {
      // CREATE IF NOT EXISTS makes this migration a safe baseline for existing v0.6.x databases.
      db.exec(BASELINE_SCHEMA_SQL);
    },
  },
];

function validateMigrations(migrations: readonly SchemaMigration[]): void {
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (!Number.isSafeInteger(migration.version) || migration.version !== expectedVersion) {
      throw new Error(
        `schema migrations must be contiguous and ordered from version 1; expected ${expectedVersion}, received ${String(migration.version)}`,
      );
    }
    if (migration.name.trim() === '' || names.has(migration.name)) {
      throw new Error(`schema migration names must be non-empty and unique: ${migration.name}`);
    }
    names.add(migration.name);
  }
}

function ensureMigrationTable(db: SqliteDatabase): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);
`);
}

function readAppliedMigrations(
  db: SqliteDatabase,
): Array<{ version: number; name: string }> {
  return db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
}

function validateAppliedMigrations(
  applied: ReadonlyArray<{ version: number; name: string }>,
  migrations: readonly SchemaMigration[],
): void {
  for (const [index, record] of applied.entries()) {
    const expectedVersion = index + 1;
    if (record.version !== expectedVersion) {
      throw new Error(
        `schema_migrations contains a version gap or out-of-order record at ${record.version}`,
      );
    }
    const migration = migrations[index];
    if (migration === undefined) {
      throw new Error(
        `database schema version ${record.version} is newer than this application supports`,
      );
    }
    if (migration.name !== record.name) {
      throw new Error(
        `schema migration version ${record.version} name conflict: expected ${migration.name}, found ${record.name}`,
      );
    }
  }
}

export function runMigrations(
  db: SqliteDatabase,
  migrations: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
): MigrationRunResult {
  validateMigrations(migrations);
  ensureMigrationTable(db);

  const appliedBefore = readAppliedMigrations(db);
  validateAppliedMigrations(appliedBefore, migrations);
  const appliedVersions = new Set(appliedBefore.map((record) => record.version));
  const newlyAppliedVersions: number[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyMigration = db.transaction(() => {
      migration.up(db);
      const appliedAt = Date.now();
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, appliedAt);
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES ('schema_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(String(migration.version), appliedAt);
    });

    applyMigration();
    appliedVersions.add(migration.version);
    newlyAppliedVersions.push(migration.version);
  }

  const appliedAfter = readAppliedMigrations(db);
  validateAppliedMigrations(appliedAfter, migrations);
  return {
    currentVersion: appliedAfter.at(-1)?.version ?? 0,
    appliedVersions: appliedAfter.map((record) => record.version),
    newlyAppliedVersions,
  };
}
