import { nanoid } from 'nanoid';
import type { JobRecord, JobSeekerProfile } from '../src/storage';
import { withJobRecordDefaults, type StoredJobRecord } from '../src/storage/defaults';
import type { SqliteDatabase } from './db';
import { JobRepository } from './repositories/jobRepository';
import { ProfileRepository } from './repositories/profileRepository';
import type { ApiImportWarning, ImportApplyResult, ImportSummary, ParsedLocalStorageBackup } from './types';

type BackupEntries = Array<[string, unknown]>;

const CURRENT_PROFILE = 'offerflow:profile';
const LEGACY_PROFILE = 'offerpilot:profile';
const CURRENT_JOB_PREFIX = 'offerflow:job:';
const LEGACY_JOB_PREFIX = 'offerpilot:job:';

function ignoredByRule(key: string): boolean {
  return (
    key === 'PASSWORD' ||
    key === 'token' ||
    key.startsWith('__tea_sdk') ||
    key.startsWith('__VUE_DEVTOOLS') ||
    key === 'i18nextLng'
  );
}

function entriesFromBackup(input: unknown): BackupEntries {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('backup JSON must be an object');
  }
  const obj = input as Record<string, unknown>;
  const source =
    obj.localStorage && typeof obj.localStorage === 'object'
      ? (obj.localStorage as Record<string, unknown>)
      : obj.items && typeof obj.items === 'object'
        ? (obj.items as Record<string, unknown>)
        : obj;
  return Object.entries(source);
}

function parseValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function emptySummary(): ImportSummary {
  return {
    profileCount: 0,
    jobCount: 0,
    ignoredKeyCount: 0,
    parseErrorCount: 0,
    warnings: [],
    imported: false,
  };
}

function preferCurrent<T>(current: T | null, legacy: T | null): T | null {
  return current ?? legacy;
}

export function parseLocalStorageBackup(input: unknown): ParsedLocalStorageBackup {
  const summary = emptySummary();
  const warnings: ApiImportWarning[] = [];
  let currentProfile: JobSeekerProfile | null = null;
  let legacyProfile: JobSeekerProfile | null = null;
  const currentJobs = new Map<string, JobRecord>();
  const legacyJobs = new Map<string, JobRecord>();

  for (const [key, value] of entriesFromBackup(input)) {
    const isCurrentJob = key.startsWith(CURRENT_JOB_PREFIX);
    const isLegacyJob = key.startsWith(LEGACY_JOB_PREFIX);
    const isKnown =
      key === CURRENT_PROFILE || key === LEGACY_PROFILE || isCurrentJob || isLegacyJob;

    if (!isKnown) {
      summary.ignoredKeyCount += 1;
      continue;
    }

    try {
      const parsed = parseValue(value);
      if (key === CURRENT_PROFILE) {
        currentProfile = parsed as JobSeekerProfile;
      } else if (key === LEGACY_PROFILE) {
        legacyProfile = parsed as JobSeekerProfile;
      } else {
        const job = withJobRecordDefaults(parsed as StoredJobRecord);
        const idFromKey = isCurrentJob
          ? key.slice(CURRENT_JOB_PREFIX.length)
          : key.slice(LEGACY_JOB_PREFIX.length);
        const normalized = { ...job, id: job.id || idFromKey };
        if (isCurrentJob) {
          currentJobs.set(normalized.id, normalized);
        } else {
          legacyJobs.set(normalized.id, normalized);
        }
      }
    } catch (error) {
      summary.parseErrorCount += 1;
      const reason = `JSON 解析失败：${(error as Error).message}`;
      warnings.push({ key, reason });
    }
  }

  const jobsById = new Map<string, JobRecord>(legacyJobs);
  for (const [id, job] of currentJobs) {
    jobsById.set(id, job);
  }

  const profile = preferCurrent(currentProfile, legacyProfile);
  const jobs = [...jobsById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  summary.profileCount = profile === null ? 0 : 1;
  summary.jobCount = jobs.length;
  summary.warnings = warnings;
  summary.imported = false;

  for (const [key] of entriesFromBackup(input)) {
    if (ignoredByRule(key)) {
      continue;
    }
  }

  return { profile, jobs, summary };
}

export function applyLocalStorageBackup(
  db: SqliteDatabase,
  input: unknown,
  source = 'localstorage-json',
): ImportApplyResult {
  const parsed = parseLocalStorageBackup(input);
  const profiles = new ProfileRepository(db);
  const jobs = new JobRepository(db);
  const importLogId = nanoid();

  const apply = db.transaction(() => {
    if (parsed.profile !== null) {
      profiles.save(parsed.profile);
    }
    for (const job of parsed.jobs) {
      jobs.upsert(job);
    }
    db.prepare(
      `INSERT INTO import_logs (
        id, source, profile_count, job_count, ignored_key_count,
        warning_count, created_at, data_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      importLogId,
      source,
      parsed.summary.profileCount,
      parsed.summary.jobCount,
      parsed.summary.ignoredKeyCount,
      parsed.summary.warnings.length,
      Date.now(),
      JSON.stringify(parsed.summary),
    );
  });
  apply();

  return {
    ...parsed.summary,
    imported: true,
    importLogId,
  };
}
