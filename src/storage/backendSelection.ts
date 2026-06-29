import { TauriSQLiteClient } from './sqliteClient';
import { detectStorageRuntime } from './runtimeEnv';
import type { StorageDriver } from './driver';
import type {
  SQLiteMigrationStatusClient,
  SQLiteStorageMigrationStatus,
} from './sqliteClient';
import type { StorageBackend } from './ports';
import type { StorageRuntime } from './runtimeEnv';

export const STORAGE_BACKEND_KEY = 'offerflow:storage:backend';

export type StorageBackendState =
  | 'localStorage_only'
  | 'sqlite_available'
  | 'sqlite_ready'
  | 'migration_required'
  | 'migration_running'
  | 'migration_succeeded'
  | 'migration_failed'
  | 'already_migrated'
  | 'sqlite_active'
  | 'fallback_localStorage';

export interface StorageBackendResolution {
  activeBackend: StorageBackend;
  preferredBackend: StorageBackend;
  state: StorageBackendState;
  runtime: StorageRuntime;
  sqliteStatus: SQLiteStorageMigrationStatus | null;
  reason: string;
}

export interface ResolveStorageBackendOptions {
  driver: Pick<StorageDriver, 'getItem'>;
  runtime?: StorageRuntime;
  sqliteClient?: SQLiteMigrationStatusClient;
}

export function readBackendPreference(
  driver: Pick<StorageDriver, 'getItem'>,
): StorageBackend {
  return driver.getItem(STORAGE_BACKEND_KEY) === 'sqlite' ? 'sqlite' : 'localStorage';
}

export function writeBackendPreference(
  driver: Pick<StorageDriver, 'setItem'>,
  backend: StorageBackend,
): void {
  driver.setItem(STORAGE_BACKEND_KEY, backend);
}

export async function resolveStorageBackend(
  options: ResolveStorageBackendOptions,
): Promise<StorageBackendResolution> {
  const runtime = options.runtime ?? detectStorageRuntime();
  const preferredBackend = readBackendPreference(options.driver);

  if (!runtime.isTauri) {
    return {
      activeBackend: 'localStorage',
      preferredBackend,
      state:
        preferredBackend === 'sqlite' ? 'fallback_localStorage' : 'localStorage_only',
      runtime,
      sqliteStatus: null,
      reason:
        preferredBackend === 'sqlite'
          ? 'SQLite backend was requested outside Tauri; falling back to localStorage.'
          : 'Web runtime defaults to localStorage.',
    };
  }

  const sqliteClient = options.sqliteClient ?? new TauriSQLiteClient();
  const sqliteStatus = await sqliteClient.getStorageMigrationStatus();

  if (preferredBackend !== 'sqlite') {
    return {
      activeBackend: 'localStorage',
      preferredBackend,
      state:
        sqliteStatus.migrationStatus === 'migrated'
          ? 'sqlite_ready'
          : 'sqlite_available',
      runtime,
      sqliteStatus,
      reason:
        sqliteStatus.migrationStatus === 'migrated'
          ? 'SQLite is migrated but backend preference remains localStorage.'
          : 'SQLite is available, but no explicit sqlite backend preference is set.',
    };
  }

  if (sqliteStatus.migrationStatus === 'migrated') {
    return {
      activeBackend: 'sqlite',
      preferredBackend,
      state: 'sqlite_active',
      runtime,
      sqliteStatus,
      reason: 'SQLite backend preference is explicit and migration_status=migrated.',
    };
  }

  if (sqliteStatus.lastMigrationStatus === 'failed') {
    return {
      activeBackend: 'localStorage',
      preferredBackend,
      state: 'migration_failed',
      runtime,
      sqliteStatus,
      reason:
        'SQLite backend preference is set, but the latest migration failed; falling back to localStorage.',
    };
  }

  return {
    activeBackend: 'localStorage',
    preferredBackend,
    state: 'migration_required',
    runtime,
    sqliteStatus,
    reason:
      'SQLite backend preference is set, but migration_status is not migrated; falling back to localStorage.',
  };
}
