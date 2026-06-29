import { createLegacyLocalStorageBackupPayload } from '../src/app/legacyLocalStorageBackup';
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

section('localStorage backup payload');

const driver = new MemoryStorageDriver();

driver.setItem(PROFILE_KEY, JSON.stringify({ targetCity: 'Suzhou', targetRole: 'FE' }));
driver.setItem(LEGACY_PROFILE_KEY, JSON.stringify({ targetCity: 'Shanghai' }));
driver.setItem(
  `${JOB_PREFIX}current-job`,
  JSON.stringify({ id: 'current-job', company: 'Current Co' }),
);
driver.setItem(
  `${LEGACY_JOB_PREFIX}legacy-job`,
  JSON.stringify({ id: 'legacy-job', company: 'Legacy Co' }),
);
driver.setItem(`${JOB_PREFIX}bad-json`, '{not json');
driver.setItem('unrelated:key', JSON.stringify({ ignored: true }));

const payload = createLegacyLocalStorageBackupPayload(driver, { createdAt: 1_780_000_000_000 });

check('backup version is stable', payload.backupVersion === 1);
check('createdAt can be injected for deterministic tests', payload.createdAt === 1_780_000_000_000);
check('source is localStorage', payload.source === 'localStorage');
check('current profile is preferred as primary', payload.profile?.key === PROFILE_KEY);
check('both current and legacy profiles are preserved', payload.counts.profiles === 2);
check('current and legacy jobs are parsed', payload.counts.jobs === 2);
check('bad JSON is counted as parse error', payload.counts.parseErrors === 1);
check('raw entries preserve bad JSON value', payload.rawEntries.some((entry) => entry.key === `${JOB_PREFIX}bad-json` && entry.value === '{not json'));
check('warnings identify the bad key', payload.warnings.some((warning) => warning.key === `${JOB_PREFIX}bad-json` && warning.code === 'parse_failed'));
check('unrelated keys are ignored', !payload.rawEntries.some((entry) => entry.key === 'unrelated:key'));
check('checksum is left for Rust writer', payload.checksum === null);

section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
