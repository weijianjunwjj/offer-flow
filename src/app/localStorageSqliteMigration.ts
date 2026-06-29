import {
  JOB_PREFIX,
  LEGACY_JOB_PREFIX,
  LEGACY_PROFILE_KEY,
  PROFILE_KEY,
} from '../storage';
import type { StorageDriver } from '../storage';
import type {
  LegacyBackupJobEntry,
  LegacyBackupStructuredEntry,
  LegacyBackupWarning,
  LegacyLocalStorageBackupPayload,
} from './legacyLocalStorageBackup';

export const LOCALSTORAGE_SQLITE_MIGRATION_VERSION = 1;
export const SQLITE_MIGRATION_DONE_KEY = 'offerflow:migration:sqlite:v0.4';
export const SQLITE_MIGRATION_DONE_VALUE = 'done';

export interface LocalStorageSqliteMigrationWarning {
  key: string;
  code: 'backup_warning' | 'namespace_conflict' | 'missing_backup_checksum';
  message: string;
}

export interface LocalStorageSqliteMigrationPayload {
  migrationVersion: 1;
  createdAt: number;
  source: 'localStorageBackup';
  backupChecksum: string | null;
  backupCreatedAt: number;
  profile: LegacyBackupStructuredEntry | null;
  jobs: LegacyBackupJobEntry[];
  counts: {
    profiles: number;
    jobs: number;
    backupRawEntries: number;
    backupParseErrors: number;
    warnings: number;
  };
  warnings: LocalStorageSqliteMigrationWarning[];
}

export interface LocalStorageSqliteMigrationOptions {
  createdAt?: number;
}

export function createLocalStorageSqliteMigrationPayload(
  backup: LegacyLocalStorageBackupPayload,
  options: LocalStorageSqliteMigrationOptions = {},
): LocalStorageSqliteMigrationPayload {
  const warnings = backup.warnings.map(mapBackupWarning);
  const profile = chooseMigrationProfile(backup.profiles, warnings);
  const jobs = chooseMigrationJobs(backup.jobs, warnings);

  if (!isSha256Checksum(backup.checksum)) {
    warnings.push({
      key: 'backup.checksum',
      code: 'missing_backup_checksum',
      message: 'Backup checksum is missing or not a sha256 checksum.',
    });
  }

  return {
    migrationVersion: LOCALSTORAGE_SQLITE_MIGRATION_VERSION,
    createdAt: options.createdAt ?? Date.now(),
    source: 'localStorageBackup',
    backupChecksum: backup.checksum,
    backupCreatedAt: backup.createdAt,
    profile,
    jobs,
    counts: {
      profiles: profile === null ? 0 : 1,
      jobs: jobs.length,
      backupRawEntries: backup.counts.rawEntries,
      backupParseErrors: backup.counts.parseErrors,
      warnings: warnings.length,
    },
    warnings,
  };
}

export function markSqliteMigrationDone(
  driver: Pick<StorageDriver, 'setItem'>,
): void {
  driver.setItem(SQLITE_MIGRATION_DONE_KEY, SQLITE_MIGRATION_DONE_VALUE);
}

function chooseMigrationProfile(
  profiles: LegacyBackupStructuredEntry[],
  warnings: LocalStorageSqliteMigrationWarning[],
): LegacyBackupStructuredEntry | null {
  const current = profiles.find((profile) => profile.key === PROFILE_KEY) ?? null;
  const legacy = profiles.find((profile) => profile.key === LEGACY_PROFILE_KEY) ?? null;

  if (current && legacy) {
    warnings.push({
      key: PROFILE_KEY,
      code: 'namespace_conflict',
      message: 'Both offerflow and offerpilot profiles exist; offerflow profile is preferred.',
    });
  }

  return current ?? legacy;
}

function chooseMigrationJobs(
  jobs: LegacyBackupJobEntry[],
  warnings: LocalStorageSqliteMigrationWarning[],
): LegacyBackupJobEntry[] {
  const byId = new Map<string, LegacyBackupJobEntry>();

  for (const job of jobs) {
    const existing = byId.get(job.id);
    if (!existing) {
      byId.set(job.id, job);
      continue;
    }

    if (isCurrentJobKey(job.key) && isLegacyJobKey(existing.key)) {
      warnings.push({
        key: job.key,
        code: 'namespace_conflict',
        message: `Both offerflow and offerpilot jobs exist for id ${job.id}; offerflow job is preferred.`,
      });
      byId.set(job.id, job);
      continue;
    }

    if (isLegacyJobKey(job.key) && isCurrentJobKey(existing.key)) {
      warnings.push({
        key: existing.key,
        code: 'namespace_conflict',
        message: `Both offerflow and offerpilot jobs exist for id ${job.id}; offerflow job is preferred.`,
      });
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mapBackupWarning(warning: LegacyBackupWarning): LocalStorageSqliteMigrationWarning {
  return {
    key: warning.key,
    code: 'backup_warning',
    message: `${warning.code}: ${warning.message}`,
  };
}

function isCurrentJobKey(key: string): boolean {
  return key.startsWith(JOB_PREFIX);
}

function isLegacyJobKey(key: string): boolean {
  return key.startsWith(LEGACY_JOB_PREFIX);
}

function isSha256Checksum(value: string | null): boolean {
  return value !== null && /^sha256:[0-9a-f]{64}$/.test(value);
}
