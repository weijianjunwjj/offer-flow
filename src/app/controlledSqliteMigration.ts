import { createLegacyLocalStorageBackupPayload } from './legacyLocalStorageBackup';
import {
  createLocalStorageSqliteMigrationPayload,
  markSqliteMigrationDone,
} from './localStorageSqliteMigration';
import { detectStorageRuntime, writeBackendPreference } from '../storage';
import type {
  SQLiteControlledMigrationClient,
  StorageBackendState,
  StorageDriver,
  StorageRuntime,
} from '../storage';

export type ControlledSqliteMigrationStatus =
  | 'migration_succeeded'
  | 'migration_failed'
  | 'already_migrated'
  | 'done_marker_failed';

export interface ControlledSqliteMigrationResult {
  status: ControlledSqliteMigrationStatus;
  backendState: StorageBackendState;
  backend: 'localStorage' | 'sqlite';
  backupPath: string | null;
  migrationId: string | null;
  errorCode: string | null;
  message: string;
}

export interface ControlledSqliteMigrationOptions {
  driver: StorageDriver;
  sqliteClient: SQLiteControlledMigrationClient;
  runtime?: StorageRuntime;
}

export async function runControlledLocalStorageToSqliteMigration(
  options: ControlledSqliteMigrationOptions,
): Promise<ControlledSqliteMigrationResult> {
  const runtime = options.runtime ?? detectStorageRuntime();
  if (!runtime.isTauri) {
    return {
      status: 'migration_failed',
      backendState: 'fallback_localStorage',
      backend: 'localStorage',
      backupPath: null,
      migrationId: null,
      errorCode: 'sqlite_unavailable',
      message: 'SQLite migration can only run inside the Tauri runtime.',
    };
  }

  const currentStatus = await options.sqliteClient.getStorageMigrationStatus();
  if (currentStatus.migrationStatus === 'migrated') {
    return enableSqliteAfterSuccessfulMigration(options.driver, {
      status: 'already_migrated',
      backendState: 'already_migrated',
      backupPath: null,
      migrationId: null,
      message: 'SQLite migration was already completed; no migration was rerun.',
    });
  }

  let backupPath: string | null = null;
  try {
    const backup = createLegacyLocalStorageBackupPayload(options.driver);
    const backupResult = await options.sqliteClient.writeLocalStorageBackup(backup);
    backup.checksum = backupResult.checksum;
    backupPath = backupResult.backupPath;

    const migrationPayload = createLocalStorageSqliteMigrationPayload(backup);
    const migrationResult = await options.sqliteClient.migrateLocalStorageToSqlite(
      migrationPayload,
    );

    return enableSqliteAfterSuccessfulMigration(options.driver, {
      status: 'migration_succeeded',
      backendState: 'migration_succeeded',
      backupPath,
      migrationId: migrationResult.migrationId,
      message: 'SQLite migration completed and backend preference was set to sqlite.',
    });
  } catch (error) {
    if (errorCode(error) === 'already_migrated') {
      return enableSqliteAfterSuccessfulMigration(options.driver, {
        status: 'already_migrated',
        backendState: 'already_migrated',
        backupPath,
        migrationId: null,
        message: 'SQLite migration was already completed; no migration was rerun.',
      });
    }

    return {
      status: 'migration_failed',
      backendState: 'migration_failed',
      backend: 'localStorage',
      backupPath,
      migrationId: null,
      errorCode: errorCode(error),
      message: errorMessage(error),
    };
  }
}

function enableSqliteAfterSuccessfulMigration(
  driver: StorageDriver,
  result: Omit<ControlledSqliteMigrationResult, 'backend' | 'errorCode'>,
): ControlledSqliteMigrationResult {
  try {
    markSqliteMigrationDone(driver);
  } catch (error) {
    return {
      status: 'done_marker_failed',
      backendState: 'migration_succeeded',
      backend: 'localStorage',
      backupPath: result.backupPath,
      migrationId: result.migrationId,
      errorCode: errorCode(error),
      message:
        'SQLite database migration succeeded, but the legacy localStorage done marker could not be written.',
    };
  }

  writeBackendPreference(driver, 'sqlite');
  return {
    ...result,
    backend: 'sqlite',
    errorCode: null,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === 'string') {
      return value;
    }
  }
  return 'unknown_error';
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = (error as { message?: unknown }).message;
    if (typeof value === 'string') {
      return value;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'SQLite migration failed.';
}
