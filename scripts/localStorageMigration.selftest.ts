import { createLegacyLocalStorageBackupPayload } from '../src/app/legacyLocalStorageBackup';
import {
  createLocalStorageSqliteMigrationPayload,
  markSqliteMigrationDone,
  SQLITE_MIGRATION_DONE_KEY,
  SQLITE_MIGRATION_DONE_VALUE,
} from '../src/app/localStorageSqliteMigration';
import {
  JOB_PREFIX,
  LEGACY_JOB_PREFIX,
  LEGACY_PROFILE_KEY,
  MemoryStorageDriver,
  PROFILE_KEY,
} from '../src/storage';

let passed = 0;
let failed = 0;

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

section('localStorage migration payload');

const driver = new MemoryStorageDriver();
driver.setItem(PROFILE_KEY, JSON.stringify({ targetCity: 'Suzhou' }));
driver.setItem(LEGACY_PROFILE_KEY, JSON.stringify({ targetCity: 'Shanghai' }));
driver.setItem(
  `${JOB_PREFIX}same-id`,
  JSON.stringify({ id: 'same-id', company: 'Current Co', updatedAt: 2 }),
);
driver.setItem(
  `${LEGACY_JOB_PREFIX}same-id`,
  JSON.stringify({ id: 'same-id', company: 'Legacy Co', updatedAt: 1 }),
);
driver.setItem(
  `${LEGACY_JOB_PREFIX}legacy-only`,
  JSON.stringify({ id: 'legacy-only', company: 'Legacy Only', updatedAt: 3 }),
);
driver.setItem(`${JOB_PREFIX}bad-json`, '{bad');

const backup = createLegacyLocalStorageBackupPayload(driver, { createdAt: 1_780_000_000_000 });
backup.checksum = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const migration = createLocalStorageSqliteMigrationPayload(backup, {
  createdAt: 1_780_000_000_001,
});

check('migration version is stable', migration.migrationVersion === 1);
check('backup checksum is carried forward', migration.backupChecksum === backup.checksum);
check('offerflow profile wins over legacy profile', migration.profile?.key === PROFILE_KEY);
check('profile conflict is warned', migration.warnings.some((warning) => warning.code === 'namespace_conflict' && warning.key === PROFILE_KEY));
check('duplicate job id is migrated once', migration.jobs.filter((job) => job.id === 'same-id').length === 1);
check('offerflow job wins over legacy job', migration.jobs.find((job) => job.id === 'same-id')?.key === `${JOB_PREFIX}same-id`);
check('legacy-only job is retained', migration.jobs.some((job) => job.id === 'legacy-only'));
check('backup parse warning is carried forward', migration.warnings.some((warning) => warning.code === 'backup_warning' && warning.key === `${JOB_PREFIX}bad-json`));
check('job count excludes bad JSON', migration.counts.jobs === 2);

section('migration done marker');

markSqliteMigrationDone(driver);
check('done marker is written', driver.getItem(SQLITE_MIGRATION_DONE_KEY) === SQLITE_MIGRATION_DONE_VALUE);
check('current profile remains untouched', driver.getItem(PROFILE_KEY) !== null);
check('legacy job remains untouched', driver.getItem(`${LEGACY_JOB_PREFIX}same-id`) !== null);

section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
