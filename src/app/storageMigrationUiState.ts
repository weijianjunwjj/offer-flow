import { createLegacyLocalStorageBackupPayload } from './legacyLocalStorageBackup';
import type { ControlledSqliteMigrationResult } from './controlledSqliteMigration';
import type {
  StorageBackend,
  StorageBackendResolution,
  StorageBackendState,
  StorageDriver,
  StorageRuntime,
} from '../storage';

export interface LocalStorageMigrationOverview {
  profileExists: boolean;
  profileCount: number;
  jobCount: number;
  rawEntryCount: number;
  warningCount: number;
  parseErrorCount: number;
}

export interface StorageMigrationResultView {
  status: ControlledSqliteMigrationResult['status'];
  backend: StorageBackend;
  backendSwitchedToSqlite: boolean;
  backupPath: string | null;
  migrationId: string | null;
  profileCount: number | null;
  jobCount: number | null;
  warningCount: number;
  warnings: string[];
  errorCode: string | null;
  message: string;
}

export function getLocalStorageMigrationOverview(
  driver: Pick<StorageDriver, 'getItem' | 'keys'>,
): LocalStorageMigrationOverview {
  const backup = createLegacyLocalStorageBackupPayload(driver);
  return {
    profileExists: backup.profile !== null,
    profileCount: backup.profiles.length,
    jobCount: backup.jobs.length,
    rawEntryCount: backup.rawEntries.length,
    warningCount: backup.warnings.length,
    parseErrorCount: backup.counts.parseErrors,
  };
}

export function canShowSqliteMigrationAction(runtime: StorageRuntime): boolean {
  return runtime.isTauri;
}

export function canRunSqliteMigration(
  runtime: StorageRuntime,
  isBusy: boolean,
): boolean {
  return runtime.isTauri && !isBusy;
}

export function runtimeLabel(runtime: StorageRuntime): string {
  return runtime.isTauri ? 'Tauri 桌面模式' : 'Web 浏览器模式';
}

export function backendLabel(backend: StorageBackend): string {
  return backend === 'sqlite' ? 'SQLite' : 'localStorage';
}

export function sqliteStateLabel(
  state: StorageBackendState | null,
  runtime: StorageRuntime,
): string {
  if (!runtime.isTauri) {
    return '不可用';
  }

  switch (state) {
    case 'sqlite_active':
      return '已启用';
    case 'sqlite_ready':
    case 'already_migrated':
      return '已迁移，待启用';
    case 'sqlite_available':
      return '可用，未迁移';
    case 'migration_required':
      return '需要迁移';
    case 'migration_failed':
      return '上次迁移失败';
    case 'migration_running':
      return '迁移中';
    case 'migration_succeeded':
      return '迁移成功';
    case 'fallback_localStorage':
      return '已回退 localStorage';
    case 'localStorage_only':
    case null:
      return '未检测';
    default:
      return '未检测';
  }
}

export function buildMigrationResultView(
  result: ControlledSqliteMigrationResult,
  overview: LocalStorageMigrationOverview | null,
): StorageMigrationResultView {
  return {
    status: result.status,
    backend: result.backend,
    backendSwitchedToSqlite: result.backend === 'sqlite',
    backupPath: result.backupPath,
    migrationId: result.migrationId,
    profileCount: result.profileCount ?? overview?.profileCount ?? null,
    jobCount: result.jobCount ?? overview?.jobCount ?? null,
    warningCount: result.warningCount,
    warnings: result.warnings,
    errorCode: result.errorCode,
    message: result.message,
  };
}

export function storageResolutionSummary(
  resolution: StorageBackendResolution | null,
  runtime: StorageRuntime,
): string {
  if (resolution === null) {
    return runtime.isTauri ? '尚未检查 SQLite 状态。' : 'Web 模式继续使用 localStorage。';
  }
  return resolution.reason;
}
