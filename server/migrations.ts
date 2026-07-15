import type { SqliteDatabase } from './db';
import { createJobMemorySchemaV2 } from './migrations/jobMemorySchemaV2';
import { createCapabilityBaselineSchemaV3 } from './migrations/capabilityBaselineSchemaV3';

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

export interface MigrationRunOptions {
  targetVersion?: number;
  migrations?: readonly SchemaMigration[];
  transactionMode?: 'per-migration' | 'caller-managed';
}

// 可信求职记忆（Job Memory v2）生产底座仍固定在 v2：快照、恢复与生产验证机器都以 v2 为准。
export const PRODUCTION_SCHEMA_VERSION = 2;
// G2 能力基线新增 v3；LATEST 与 PRODUCTION 有意区分，v3 为纯新增表，不改动 v2 生产语义。
export const LATEST_SCHEMA_VERSION = 3;
export const CURRENT_SCHEMA_VERSION = PRODUCTION_SCHEMA_VERSION;

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
  {
    version: 2,
    name: '002_v0_7_job_memory_schema',
    up: createJobMemorySchemaV2,
  },
  {
    version: 3,
    name: '003_v0_7_capability_baseline_schema',
    up: createCapabilityBaselineSchemaV3,
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

function validateTargetVersion(
  targetVersion: number,
  migrations: readonly SchemaMigration[],
): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1) {
    throw new Error(`schema target version must be a positive safe integer: ${String(targetVersion)}`);
  }
  const latestKnownVersion = migrations.at(-1)?.version ?? 0;
  if (targetVersion > latestKnownVersion) {
    throw new Error(
      `schema target version ${targetVersion} is newer than the latest known migration ${latestKnownVersion}`,
    );
  }
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

export function getDatabaseSchemaVersion(db: SqliteDatabase): number {
  const migrationTable = db
    .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { present: number } | undefined;
  if (migrationTable === undefined) return 0;
  const applied = readAppliedMigrations(db);
  validateAppliedMigrations(applied, SCHEMA_MIGRATIONS);
  return applied.at(-1)?.version ?? 0;
}

export function runMigrations(
  db: SqliteDatabase,
  options: MigrationRunOptions = {},
): MigrationRunResult {
  const migrations = options.migrations ?? SCHEMA_MIGRATIONS;
  const targetVersion = options.targetVersion ?? PRODUCTION_SCHEMA_VERSION;
  const transactionMode = options.transactionMode ?? 'per-migration';
  validateMigrations(migrations);
  validateTargetVersion(targetVersion, migrations);
  ensureMigrationTable(db);

  const appliedBefore = readAppliedMigrations(db);
  validateAppliedMigrations(appliedBefore, migrations);
  const currentVersionBefore = appliedBefore.at(-1)?.version ?? 0;
  if (targetVersion < currentVersionBefore) {
    throw new Error(
      `database schema version ${currentVersionBefore} cannot be downgraded to target version ${targetVersion}`,
    );
  }
  const appliedVersions = new Set(appliedBefore.map((record) => record.version));
  const newlyAppliedVersions: number[] = [];

  for (const migration of migrations) {
    if (migration.version > targetVersion) {
      break;
    }
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const applyMigration = (): void => {
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
    };

    if (transactionMode === 'caller-managed') {
      applyMigration();
    } else {
      db.transaction(applyMigration)();
    }
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
