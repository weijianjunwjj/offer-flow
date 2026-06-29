import {
  JOB_PREFIX,
  LEGACY_JOB_PREFIX,
  LEGACY_PROFILE_KEY,
  NAMESPACE,
  PROFILE_KEY,
} from '../storage';
import type { StorageDriver } from '../storage';

export const LOCALSTORAGE_BACKUP_VERSION = 1;

export type LegacyBackupNamespace = 'offerflow' | 'offerpilot';

export interface LegacyBackupRawEntry {
  key: string;
  value: string;
}

export interface LegacyBackupStructuredEntry {
  key: string;
  namespace: LegacyBackupNamespace;
  data: unknown;
}

export interface LegacyBackupJobEntry extends LegacyBackupStructuredEntry {
  id: string;
}

export interface LegacyBackupWarning {
  key: string;
  code: 'missing_value' | 'parse_failed';
  message: string;
}

export interface LegacyBackupCounts {
  profiles: number;
  jobs: number;
  rawEntries: number;
  parseErrors: number;
}

export interface LegacyLocalStorageBackupPayload {
  backupVersion: 1;
  createdAt: number;
  source: 'localStorage';
  app: 'OfferFlow';
  namespace: string;
  namespaces: LegacyBackupNamespace[];
  profile: LegacyBackupStructuredEntry | null;
  profiles: LegacyBackupStructuredEntry[];
  jobs: LegacyBackupJobEntry[];
  rawEntries: LegacyBackupRawEntry[];
  counts: LegacyBackupCounts;
  warnings: LegacyBackupWarning[];
  checksum: string | null;
}

export interface LegacyLocalStorageBackupOptions {
  createdAt?: number;
}

export function createLegacyLocalStorageBackupPayload(
  driver: Pick<StorageDriver, 'getItem' | 'keys'>,
  options: LegacyLocalStorageBackupOptions = {},
): LegacyLocalStorageBackupPayload {
  const createdAt = options.createdAt ?? Date.now();
  const keys = driver.keys().filter(isLegacyBackupKey).sort();
  const rawEntries: LegacyBackupRawEntry[] = [];
  const profiles: LegacyBackupStructuredEntry[] = [];
  const jobs: LegacyBackupJobEntry[] = [];
  const warnings: LegacyBackupWarning[] = [];

  for (const key of keys) {
    const value = driver.getItem(key);
    if (value === null) {
      warnings.push({
        key,
        code: 'missing_value',
        message: 'Storage key was listed but no value was returned.',
      });
      continue;
    }

    rawEntries.push({ key, value });

    const parsed = parseRawEntry(key, value, warnings);
    if (parsed === null) {
      continue;
    }

    if (isProfileBackupKey(key)) {
      profiles.push({
        key,
        namespace: namespaceFromKey(key),
        data: parsed,
      });
      continue;
    }

    if (isJobBackupKey(key)) {
      jobs.push({
        key,
        namespace: namespaceFromKey(key),
        id: jobIdFromKey(key),
        data: parsed,
      });
    }
  }

  return {
    backupVersion: LOCALSTORAGE_BACKUP_VERSION,
    createdAt,
    source: 'localStorage',
    app: 'OfferFlow',
    namespace: 'offerflow+offerpilot',
    namespaces: ['offerflow', 'offerpilot'],
    profile: choosePrimaryProfile(profiles),
    profiles,
    jobs,
    rawEntries,
    counts: {
      profiles: profiles.length,
      jobs: jobs.length,
      rawEntries: rawEntries.length,
      parseErrors: warnings.filter((warning) => warning.code === 'parse_failed').length,
    },
    warnings,
    checksum: null,
  };
}

function isLegacyBackupKey(key: string): boolean {
  return isProfileBackupKey(key) || isJobBackupKey(key);
}

function isProfileBackupKey(key: string): boolean {
  return key === PROFILE_KEY || key === LEGACY_PROFILE_KEY;
}

function isJobBackupKey(key: string): boolean {
  return key.startsWith(JOB_PREFIX) || key.startsWith(LEGACY_JOB_PREFIX);
}

function namespaceFromKey(key: string): LegacyBackupNamespace {
  return key.startsWith(NAMESPACE) ? 'offerflow' : 'offerpilot';
}

function jobIdFromKey(key: string): string {
  if (key.startsWith(JOB_PREFIX)) {
    return key.slice(JOB_PREFIX.length);
  }
  return key.slice(LEGACY_JOB_PREFIX.length);
}

function parseRawEntry(
  key: string,
  value: string,
  warnings: LegacyBackupWarning[],
): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    warnings.push({
      key,
      code: 'parse_failed',
      message: error instanceof Error ? error.message : 'JSON parse failed.',
    });
    return null;
  }
}

function choosePrimaryProfile(
  profiles: LegacyBackupStructuredEntry[],
): LegacyBackupStructuredEntry | null {
  return (
    profiles.find((profile) => profile.key === PROFILE_KEY) ??
    profiles.find((profile) => profile.key === LEGACY_PROFILE_KEY) ??
    null
  );
}
