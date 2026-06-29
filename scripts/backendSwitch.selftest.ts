import { initializeStorageBackend } from '../src/app/stores';
import { runControlledLocalStorageToSqliteMigration } from '../src/app/controlledSqliteMigration';
import {
  JOB_PREFIX,
  MemoryStorageDriver,
  PROFILE_KEY,
  STORAGE_BACKEND_KEY,
  resolveStorageBackend,
  writeBackendPreference,
} from '../src/storage';
import { SQLITE_MIGRATION_DONE_KEY } from '../src/app/localStorageSqliteMigration';
import type {
  LocalStorageBackupWriteResult,
  LocalStorageMigrationResult,
  SQLiteControlledMigrationClient,
  SQLiteStorageMigrationStatus,
  StorageDriver,
  StorageRuntime,
} from '../src/storage';

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

class FakeMigrationClient implements SQLiteControlledMigrationClient {
  backupCalls = 0;
  migrationCalls = 0;
  shouldFailBackup = false;
  shouldFailMigration = false;

  constructor(private status: SQLiteStorageMigrationStatus) {}

  async getStorageMigrationStatus(): Promise<SQLiteStorageMigrationStatus> {
    return this.status;
  }

  async writeLocalStorageBackup(): Promise<LocalStorageBackupWriteResult> {
    this.backupCalls += 1;
    if (this.shouldFailBackup) {
      throw { code: 'backup_write_failed', message: 'backup failed' };
    }
    return {
      dbPath: ':memory:',
      backupPath: 'backup.json',
      fileName: 'backup.json',
      checksum: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      sizeBytes: 100,
      profileCount: 1,
      jobCount: 1,
      rawEntryCount: 2,
      backupLogId: 'backup-log',
    };
  }

  async migrateLocalStorageToSqlite(): Promise<LocalStorageMigrationResult> {
    this.migrationCalls += 1;
    if (this.shouldFailMigration) {
      throw { code: 'write_failed', message: 'migration failed' };
    }
    this.status = {
      migrationStatus: 'migrated',
      lastMigrationStatus: 'succeeded',
    };
    return {
      dbPath: ':memory:',
      migrationId: 'migration-1',
      status: 'succeeded',
      profileCount: 1,
      jobCount: 1,
      backupChecksum: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      migrationStatus: 'migrated',
    };
  }
}

class FailingDoneStorageDriver extends MemoryStorageDriver {
  setItem(key: string, value: string): void {
    if (key === SQLITE_MIGRATION_DONE_KEY) {
      throw new Error('done marker failed');
    }
    super.setItem(key, value);
  }
}

function seededDriver(driver: StorageDriver = new MemoryStorageDriver()): StorageDriver {
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
      createdAt: 1,
      updatedAt: 2,
      company: 'Seed Co',
      role: 'Frontend Engineer',
      communicationStatus: 'not_contacted',
      aiRawResult: 'raw',
    }),
  );
  return driver;
}

async function main(): Promise<void> {
  section('backend selection');

  const webDefaultDriver = new MemoryStorageDriver();
  const webDefault = await resolveStorageBackend({
    driver: webDefaultDriver,
    runtime: webRuntime,
  });
  check('Web/default resolves localStorage_only', webDefault.state === 'localStorage_only');
  check('Web/default active backend is localStorage', webDefault.activeBackend === 'localStorage');

  const webSqliteDriver = new MemoryStorageDriver();
  writeBackendPreference(webSqliteDriver, 'sqlite');
  const webSqlite = await resolveStorageBackend({
    driver: webSqliteDriver,
    runtime: webRuntime,
  });
  check('Web/sqlite preference falls back to localStorage', webSqlite.state === 'fallback_localStorage' && webSqlite.activeBackend === 'localStorage');

  const tauriDefault = await resolveStorageBackend({
    driver: new MemoryStorageDriver(),
    runtime: tauriRuntime,
    sqliteClient: new FakeMigrationClient({
      migrationStatus: null,
      lastMigrationStatus: null,
    }),
  });
  check('Tauri/default exposes sqlite_available but keeps localStorage active', tauriDefault.state === 'sqlite_available' && tauriDefault.activeBackend === 'localStorage');

  const tauriReadyDriver = new MemoryStorageDriver();
  const tauriReady = await resolveStorageBackend({
    driver: tauriReadyDriver,
    runtime: tauriRuntime,
    sqliteClient: new FakeMigrationClient({
      migrationStatus: 'migrated',
      lastMigrationStatus: 'succeeded',
    }),
  });
  check('Tauri/migrated without preference is sqlite_ready, not active', tauriReady.state === 'sqlite_ready' && tauriReady.activeBackend === 'localStorage');

  const sqliteActiveDriver = new MemoryStorageDriver();
  writeBackendPreference(sqliteActiveDriver, 'sqlite');
  const sqliteActive = await resolveStorageBackend({
    driver: sqliteActiveDriver,
    runtime: tauriRuntime,
    sqliteClient: new FakeMigrationClient({
      migrationStatus: 'migrated',
      lastMigrationStatus: 'succeeded',
    }),
  });
  check('Explicit sqlite plus migrated becomes sqlite_active', sqliteActive.state === 'sqlite_active' && sqliteActive.activeBackend === 'sqlite');

  const migrationRequiredDriver = new MemoryStorageDriver();
  writeBackendPreference(migrationRequiredDriver, 'sqlite');
  const migrationRequired = await resolveStorageBackend({
    driver: migrationRequiredDriver,
    runtime: tauriRuntime,
    sqliteClient: new FakeMigrationClient({
      migrationStatus: null,
      lastMigrationStatus: null,
    }),
  });
  check('Explicit sqlite without migrated requires migration and falls back', migrationRequired.state === 'migration_required' && migrationRequired.activeBackend === 'localStorage');

  const migrationFailedDriver = new MemoryStorageDriver();
  writeBackendPreference(migrationFailedDriver, 'sqlite');
  const migrationFailed = await resolveStorageBackend({
    driver: migrationFailedDriver,
    runtime: tauriRuntime,
    sqliteClient: new FakeMigrationClient({
      migrationStatus: null,
      lastMigrationStatus: 'failed',
    }),
  });
  check('Failed migration state falls back to localStorage', migrationFailed.state === 'migration_failed' && migrationFailed.activeBackend === 'localStorage');

  const bootDriver = new MemoryStorageDriver();
  const boot = await initializeStorageBackend({
    storageDriver: bootDriver,
    runtime: webRuntime,
  });
  check('initializeStorageBackend keeps Web/default on localStorage stores', boot.resolution.activeBackend === 'localStorage' && boot.stores.backend === 'localStorage');

  section('controlled migration');

  const successDriver = seededDriver();
  const successClient = new FakeMigrationClient({
    migrationStatus: null,
    lastMigrationStatus: null,
  });
  const success = await runControlledLocalStorageToSqliteMigration({
    driver: successDriver,
    runtime: tauriRuntime,
    sqliteClient: successClient,
  });
  check('migration success writes backend=sqlite', success.status === 'migration_succeeded' && successDriver.getItem(STORAGE_BACKEND_KEY) === 'sqlite');
  check('migration success writes done marker', successDriver.getItem(SQLITE_MIGRATION_DONE_KEY) === 'done');
  check('migration success preserves old localStorage profile', successDriver.getItem(PROFILE_KEY) !== null);

  const failedDriver = seededDriver();
  const failedClient = new FakeMigrationClient({
    migrationStatus: null,
    lastMigrationStatus: null,
  });
  failedClient.shouldFailMigration = true;
  const failedResult = await runControlledLocalStorageToSqliteMigration({
    driver: failedDriver,
    runtime: tauriRuntime,
    sqliteClient: failedClient,
  });
  check('migration failed does not write backend=sqlite', failedResult.status === 'migration_failed' && failedDriver.getItem(STORAGE_BACKEND_KEY) === null);
  check('migration failed does not write done marker', failedDriver.getItem(SQLITE_MIGRATION_DONE_KEY) === null);
  check('migration failed preserves old localStorage job', failedDriver.getItem(`${JOB_PREFIX}job-1`) !== null);

  const backupFailedDriver = seededDriver();
  const backupFailedClient = new FakeMigrationClient({
    migrationStatus: null,
    lastMigrationStatus: null,
  });
  backupFailedClient.shouldFailBackup = true;
  const backupFailed = await runControlledLocalStorageToSqliteMigration({
    driver: backupFailedDriver,
    runtime: tauriRuntime,
    sqliteClient: backupFailedClient,
  });
  check('backup failure does not execute migration', backupFailed.status === 'migration_failed' && backupFailedClient.migrationCalls === 0);
  check('backup failure does not write backend=sqlite', backupFailedDriver.getItem(STORAGE_BACKEND_KEY) === null);

  const alreadyDriver = seededDriver();
  const alreadyClient = new FakeMigrationClient({
    migrationStatus: 'migrated',
    lastMigrationStatus: 'succeeded',
  });
  const already = await runControlledLocalStorageToSqliteMigration({
    driver: alreadyDriver,
    runtime: tauriRuntime,
    sqliteClient: alreadyClient,
  });
  check('already_migrated does not rerun backup or migration', already.status === 'already_migrated' && alreadyClient.backupCalls === 0 && alreadyClient.migrationCalls === 0);
  check('already_migrated can enable sqlite backend explicitly', alreadyDriver.getItem(STORAGE_BACKEND_KEY) === 'sqlite');

  const doneFailedDriver = seededDriver(new FailingDoneStorageDriver());
  const doneFailedClient = new FakeMigrationClient({
    migrationStatus: null,
    lastMigrationStatus: null,
  });
  const doneFailed = await runControlledLocalStorageToSqliteMigration({
    driver: doneFailedDriver,
    runtime: tauriRuntime,
    sqliteClient: doneFailedClient,
  });
  check('done marker failure is explicit', doneFailed.status === 'done_marker_failed');
  check('done marker failure does not write backend=sqlite', doneFailedDriver.getItem(STORAGE_BACKEND_KEY) === null);
  check('done marker failure preserves old localStorage', doneFailedDriver.getItem(PROFILE_KEY) !== null);

  section('Summary');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
