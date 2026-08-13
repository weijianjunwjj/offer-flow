import Database from 'better-sqlite3';
import { DatabaseSync } from 'node:sqlite';
import {
  NOVAWING_AUTHORITATIVE_TABLE_NAMES,
  NOVAWING_SCHEMA_VERSION,
  createInjectedSqliteNovaWingStore,
  inspectNovaWingMigration,
} from '@weijianjunwjj/nova-wing/sqlite';
import { getDatabaseSchemaVersion, LATEST_SCHEMA_VERSION, RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION } from '../../migrations';
import { HostSnapshotV3Error, hostSnapshotError } from './errors';
import { validateExistingInputFile } from './pathSafety';

export const NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION =
  'BOOTSTRAP_NOVAWING_SCHEMA_OFFLINE' as const;

export interface OfflineNovaWingBootstrapOptions {
  databasePath: string;
  confirmation: typeof NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION;
  dryRun?: boolean;
}

export interface OfflineNovaWingBootstrapReport {
  status: 'planned' | 'bootstrapped' | 'already-compatible';
  offerFlowSchemaVersion: number;
  novaWingSchemaVersion: number;
  authoritativeTableCount: number;
  schemaFingerprint: string | null;
}

function resolveDatabasePath(raw: string): string {
  return validateExistingInputFile(raw).path;
}

function assertOfferFlowSchema(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const version = getDatabaseSchemaVersion(db);
    if (version < RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION) {
      throw hostSnapshotError(
        'HOST_SNAPSHOT_V3_SCHEMA_MISMATCH',
        `NovaWing bootstrap 要求 OfferFlow schema >= v${RADAR_CANDIDATE_RELATIONS_SCHEMA_VERSION}，实际 v${version}`,
      );
    }
  } finally {
    db.close();
  }
}

function listNovaWingTables(connection: DatabaseSync): string[] {
  return (connection.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'nw_%' ORDER BY name",
  ).all() as Array<{ name: unknown }>).map((row) => String(row.name));
}

function assertDeleteJournal(connection: DatabaseSync): void {
  const row = connection.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
  if (typeof row?.journal_mode !== 'string' || row.journal_mode.toLowerCase() !== 'delete') {
    throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', '离线生命周期要求 journal_mode=DELETE');
  }
}

function acquireAndReleaseExclusiveProbe(connection: DatabaseSync): void {
  try {
    connection.exec('PRAGMA busy_timeout = 100');
    connection.exec('BEGIN EXCLUSIVE');
    connection.exec('ROLLBACK');
  } catch {
    try { connection.exec('ROLLBACK'); } catch { /* The probe might fail before BEGIN. */ }
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_OFFLINE_LOCK_REQUIRED',
      'NovaWing bootstrap 需要服务离线且无活动数据库操作',
    );
  }
}

function exactTableState(actual: readonly string[]): 'missing' | 'compatible' | 'incompatible' {
  if (actual.length === 0) return 'missing';
  const expected = [...NOVAWING_AUTHORITATIVE_TABLE_NAMES].sort();
  return JSON.stringify(actual) === JSON.stringify(expected) ? 'compatible' : 'incompatible';
}

export function bootstrapNovaWingOffline(
  options: OfflineNovaWingBootstrapOptions,
): OfflineNovaWingBootstrapReport {
  if (options.confirmation !== NOVAWING_OFFLINE_BOOTSTRAP_CONFIRMATION) {
    throw hostSnapshotError(
      'HOST_SNAPSHOT_V3_CONFIRMATION_REQUIRED',
      'NovaWing bootstrap 缺少显式离线确认',
    );
  }
  const databasePath = resolveDatabasePath(options.databasePath);
  try {
    assertOfferFlowSchema(databasePath);
    const connection = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 100,
    });
    let store: ReturnType<typeof createInjectedSqliteNovaWingStore> | undefined;
    try {
      assertDeleteJournal(connection);
      acquireAndReleaseExclusiveProbe(connection);
      const state = exactTableState(listNovaWingTables(connection));
      if (state === 'incompatible') {
        throw hostSnapshotError('HOST_SNAPSHOT_V3_SCHEMA_MISMATCH', '检测到不兼容的 NovaWing schema');
      }
      if (options.dryRun) {
        if (state === 'compatible') {
          store = createInjectedSqliteNovaWingStore({ connection, migrationMode: 'validate' });
          const descriptor = inspectNovaWingMigration(connection);
          return {
            status: 'planned',
            offerFlowSchemaVersion: LATEST_SCHEMA_VERSION,
            novaWingSchemaVersion: descriptor.schemaVersion,
            authoritativeTableCount: descriptor.authoritativeTables.length,
            schemaFingerprint: descriptor.fingerprint,
          };
        }
        return {
          status: 'planned',
          offerFlowSchemaVersion: LATEST_SCHEMA_VERSION,
          novaWingSchemaVersion: NOVAWING_SCHEMA_VERSION,
          authoritativeTableCount: NOVAWING_AUTHORITATIVE_TABLE_NAMES.length,
          schemaFingerprint: null,
        };
      }
      if (state === 'missing') {
        store = createInjectedSqliteNovaWingStore({
          connection,
          migrationMode: 'apply',
          busyTimeoutMs: 5_000,
          busyRetries: 2,
          busyRetryDelayMs: 100,
        });
      } else {
        store = createInjectedSqliteNovaWingStore({
          connection,
          migrationMode: 'validate',
          busyTimeoutMs: 5_000,
          busyRetries: 2,
          busyRetryDelayMs: 100,
        });
      }
      const descriptor = inspectNovaWingMigration(connection);
      return {
        status: state === 'missing' ? 'bootstrapped' : 'already-compatible',
        offerFlowSchemaVersion: LATEST_SCHEMA_VERSION,
        novaWingSchemaVersion: descriptor.schemaVersion,
        authoritativeTableCount: descriptor.authoritativeTables.length,
        schemaFingerprint: descriptor.fingerprint,
      };
    } finally {
      try { store?.close(); } finally { connection.close(); }
    }
  } catch (error) {
    if (error instanceof HostSnapshotV3Error) throw error;
    throw hostSnapshotError('HOST_SNAPSHOT_V3_BOOTSTRAP_FAILED', 'NovaWing 离线 bootstrap 失败');
  }
}
