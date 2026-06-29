import {
  buildMigrationResultView,
  canRunSqliteMigration,
  canShowSqliteMigrationAction,
  getLocalStorageMigrationOverview,
  runtimeLabel,
  sqliteStateLabel,
} from '../src/app/storageMigrationUiState';
import { JOB_PREFIX, MemoryStorageDriver, PROFILE_KEY } from '../src/storage';
import type { ControlledSqliteMigrationResult } from '../src/app/controlledSqliteMigration';
import type { StorageRuntime } from '../src/storage';

let passed = 0;
let failed = 0;

const webRuntime: StorageRuntime = { kind: 'web', isTauri: false };
const tauriRuntime: StorageRuntime = { kind: 'tauri', isTauri: true };

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function seedLocalStorage(): MemoryStorageDriver {
  const driver = new MemoryStorageDriver();
  driver.setItem(
    PROFILE_KEY,
    JSON.stringify({
      targetCity: 'Suzhou',
      targetRole: 'Frontend Developer',
    }),
  );
  driver.setItem(
    `${JOB_PREFIX}job-1`,
    JSON.stringify({
      id: 'job-1',
      company: 'Seed Co',
      role: 'Frontend Engineer',
      updatedAt: 2,
    }),
  );
  return driver;
}

function resultFixture(
  patch: Partial<ControlledSqliteMigrationResult>,
): ControlledSqliteMigrationResult {
  return {
    status: 'migration_succeeded',
    backendState: 'migration_succeeded',
    backend: 'sqlite',
    backupPath: 'C:\\Users\\Administrator\\AppData\\Roaming\\backup.json',
    migrationId: 'migration-1',
    profileCount: 1,
    jobCount: 1,
    warningCount: 0,
    warnings: [],
    errorCode: null,
    message: 'ok',
    ...patch,
  };
}

function main(): void {
  section('localStorage overview');
  const overview = getLocalStorageMigrationOverview(seedLocalStorage());
  check('overview detects profile', overview.profileExists);
  check('overview counts selected jobs', overview.jobCount === 1);
  check('overview keeps raw entry count', overview.rawEntryCount === 2);

  section('runtime gating');
  check('Web runtime label is explicit', runtimeLabel(webRuntime) === 'Web 浏览器模式');
  check('Tauri runtime label is explicit', runtimeLabel(tauriRuntime) === 'Tauri 桌面模式');
  check('Web does not show executable SQLite migration action', !canShowSqliteMigrationAction(webRuntime));
  check('Tauri can show SQLite migration action', canShowSqliteMigrationAction(tauriRuntime));
  check('Web cannot run migration even when idle', !canRunSqliteMigration(webRuntime, false));
  check('Tauri cannot run migration while busy', !canRunSqliteMigration(tauriRuntime, true));
  check('Tauri can run migration when idle', canRunSqliteMigration(tauriRuntime, false));
  check('Web SQLite state is unavailable', sqliteStateLabel('localStorage_only', webRuntime) === '不可用');

  section('result view');
  const successView = buildMigrationResultView(resultFixture({}), overview);
  check('success view exposes backup path', successView.backupPath?.endsWith('backup.json') === true);
  check('success view exposes migration id', successView.migrationId === 'migration-1');
  check('success view exposes job count', successView.jobCount === 1);
  check('success view marks backend switched', successView.backendSwitchedToSqlite);

  const failedView = buildMigrationResultView(
    resultFixture({
      status: 'migration_failed',
      backendState: 'migration_failed',
      backend: 'localStorage',
      backupPath: null,
      migrationId: null,
      profileCount: null,
      jobCount: null,
      errorCode: 'write_failed',
      message: 'migration failed',
    }),
    overview,
  );
  check('failed view falls back to localStorage', failedView.backend === 'localStorage');
  check('failed view keeps fallback job count for display', failedView.jobCount === 1);
  check('failed view exposes error code', failedView.errorCode === 'write_failed');

  section('Summary');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
