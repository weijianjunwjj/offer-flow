import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  JobRecordSchema,
} from '../../../src/domain/job-memory';
import type { CommunicationStatus } from '../../../src/storage';
import { withJobRecordDefaults, type StoredJobRecord } from '../../../src/storage/defaults';
import { getDatabaseSchemaVersion } from '../../migrations';
import { sha256Hex } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import type {
  LegacyOfferFlowSnapshotV1 as OfferFlowSnapshot,
  LegacySnapshotManifestV1 as SnapshotManifest,
  SnapshotTable,
  SyncTableName,
} from '../../sync/types';
import { resolveUpgradePaths, type UpgradePathsInput } from './pathSafety';

const LEGACY_STATUSES = [
  'not_contacted', 'greeted_unread', 'greeted_read_no_reply', 'replied',
  'interviewing', 'paused', 'closed', 'rejected',
] as const satisfies readonly CommunicationStatus[];

const JOB_FIELDS = new Set([
  'id', 'createdAt', 'updatedAt', 'company', 'role', 'city', 'salaryRange', 'jdText',
  'promptText', 'aiRawResult', 'aiPastedAt', 'parseStatus', 'report', 'matchScore',
  'companyInput', 'companyAssessment', 'opportunityAnalysis', 'communicationStatus',
  'lastGreetedAt', 'followupCount', 'lastFollowupAt', 'lastCommunicationNote',
  'highValueSignal', 'strategyOverride', 'draftMessageText', 'importStatus',
  'reviewStatus', 'importSource', 'importedDraft', 'contactStatus', 'contactStatusUpdatedAt',
]);

export interface SnapshotV1Inspection {
  snapshotPresent: boolean;
  manifestPresent: boolean;
  schemaVersion: number | null;
  hashValid: boolean | null;
  consistencyOk: boolean | null;
  differenceCounts: Record<string, number>;
  snapshotHash: string | null;
  files: Array<{ name: string; sizeBytes: number; sha256: string }>;
}

export interface DatabaseInspectionReport {
  toolVersion: 'b7-a-v1';
  schemaVersion: number;
  appMetaSchemaVersion: number | null;
  migrationConsistent: boolean;
  migrationRecords: Array<{ version: number; name: string; appliedAt: number }>;
  integrity: string[];
  foreignKeyViolationCount: number;
  journalMode: string;
  walPresent: boolean;
  shmPresent: boolean;
  tableCounts: Record<string, number>;
  duplicateJobIdCount: number;
  jobValidation: {
    parseErrorCount: number;
    schemaErrorCount: number;
    unknownFieldCount: number;
    invalidAnonymousIds: string[];
  };
  legacyStatusCounts: Record<string, number>;
  v2TablesPresent: string[];
  sourceFile: { sizeBytes: number; sha256: string };
  businessTableHashes: Record<string, string>;
  snapshotV1: SnapshotV1Inspection;
  upgradeEligible: boolean;
}

function firstColumn(row: Record<string, unknown>): string {
  const key = Object.keys(row)[0];
  return String(key === undefined ? '' : row[key]);
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function tableCount(db: Database.Database, table: string): number {
  if (!tableExists(db, table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM \"${table}\"`).get() as { count: number }).count);
}

function tableHash(db: Database.Database, table: string): string {
  if (!tableExists(db, table)) return sha256Hex('missing');
  const snapshot = readSnapshotTable(db, table as SyncTableName);
  return sha256Hex(JSON.stringify(snapshot));
}

function anonymousId(value: unknown): string {
  return sha256Hex(String(value ?? '')).slice(0, 12);
}

function snapshotTableHash(table: SnapshotTable): string {
  return sha256Hex(JSON.stringify(table));
}

function inspectSnapshotV1(
  db: Database.Database,
  workspaceDirectory: string,
): SnapshotV1Inspection {
  const snapshotPath = path.join(workspaceDirectory, 'sync', 'offerflow.snapshot.json');
  const manifestPath = path.join(workspaceDirectory, 'sync', 'offerflow.manifest.json');
  const snapshotPresent = fs.existsSync(snapshotPath);
  const manifestPresent = fs.existsSync(manifestPath);
  const files: SnapshotV1Inspection['files'] = [];
  for (const [name, filePath] of [
    ['offerflow.snapshot.json', snapshotPath],
    ['offerflow.manifest.json', manifestPath],
  ] as const) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath);
    files.push({ name, sizeBytes: content.byteLength, sha256: sha256Hex(content) });
  }
  if (!snapshotPresent || !manifestPresent) {
    return {
      snapshotPresent,
      manifestPresent,
      schemaVersion: null,
      hashValid: null,
      consistencyOk: null,
      differenceCounts: {},
      snapshotHash: null,
      files,
    };
  }
  try {
    const snapshotText = fs.readFileSync(snapshotPath, 'utf8');
    const snapshot = JSON.parse(snapshotText) as OfferFlowSnapshot;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
    const snapshotHash = sha256Hex(snapshotText);
    const hashValid = manifest.snapshotHash === snapshotHash;
    const differenceCounts: Record<string, number> = {};
    if (hashValid && snapshot.schemaVersion === 1 && manifest.schemaVersion === 1) {
      for (const table of ['profiles', 'jobs', 'import_logs'] as const) {
        const databaseTable = readSnapshotTable(db, table);
        const snapshotTable = snapshot.tables[table];
        differenceCounts[table] = snapshotTable === undefined
          ? databaseTable.rows.length
          : snapshotTableHash(databaseTable) === snapshotTableHash(snapshotTable)
            ? 0
            : Math.max(databaseTable.rows.length, snapshotTable.rows.length, 1);
      }
    }
    return {
      snapshotPresent,
      manifestPresent,
      schemaVersion: snapshot.schemaVersion,
      hashValid,
      consistencyOk: hashValid
        && snapshot.schemaVersion === 1
        && manifest.schemaVersion === 1
        && Object.values(differenceCounts).every((count) => count === 0),
      differenceCounts,
      snapshotHash,
      files,
    };
  } catch {
    return {
      snapshotPresent,
      manifestPresent,
      schemaVersion: null,
      hashValid: false,
      consistencyOk: false,
      differenceCounts: {},
      snapshotHash: null,
      files,
    };
  }
}

export function inspectSourceDatabase(input: UpgradePathsInput): DatabaseInspectionReport {
  const paths = resolveUpgradePaths(input);
  const sourceBytes = fs.readFileSync(paths.sourceDatabasePath);
  const db = new Database(paths.sourceDatabasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map(firstColumn);
    const foreignKeyViolationCount = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    const journalMode = firstColumn(db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>);
    let schemaVersion = 0;
    let migrationConsistent = true;
    try {
      schemaVersion = getDatabaseSchemaVersion(db);
    } catch {
      migrationConsistent = false;
    }
    const migrationRecords = tableExists(db, 'schema_migrations')
      ? db.prepare(
          'SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version',
        ).all() as Array<{ version: number; name: string; appliedAt: number }>
      : [];
    const appMeta = tableExists(db, 'app_meta')
      ? db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      : undefined;
    const appMetaSchemaVersion = appMeta === undefined || !/^\d+$/.test(appMeta.value)
      ? null
      : Number(appMeta.value);
    if (appMetaSchemaVersion !== schemaVersion) migrationConsistent = false;

    const tableCounts = Object.fromEntries(
      ['profiles', 'jobs', 'import_logs', 'resume_versions', 'applications', 'feedback_events']
        .map((table) => [table, tableCount(db, table)]),
    );
    const duplicateJobIdCount = tableExists(db, 'jobs')
      ? Number((db.prepare(
          'SELECT COUNT(*) AS count FROM (SELECT id FROM jobs GROUP BY id HAVING COUNT(*) > 1)',
        ).get() as { count: number }).count)
      : 0;
    const jobValidation = {
      parseErrorCount: 0,
      schemaErrorCount: 0,
      unknownFieldCount: 0,
      invalidAnonymousIds: [] as string[],
    };
    const legacyStatusCounts: Record<string, number> = Object.fromEntries(
      [...LEGACY_STATUSES, 'invalid'].map((status) => [status, 0]),
    );
    if (tableExists(db, 'jobs')) {
      const rows = db.prepare('SELECT id, data_json FROM jobs ORDER BY id').all() as Array<{
        id: string;
        data_json: string;
      }>;
      for (const row of rows) {
        let raw: unknown;
        try {
          raw = JSON.parse(row.data_json) as unknown;
        } catch {
          jobValidation.parseErrorCount += 1;
          jobValidation.invalidAnonymousIds.push(anonymousId(row.id));
          legacyStatusCounts.invalid += 1;
          continue;
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          jobValidation.schemaErrorCount += 1;
          jobValidation.invalidAnonymousIds.push(anonymousId(row.id));
          legacyStatusCounts.invalid += 1;
          continue;
        }
        const record = raw as Record<string, unknown>;
        jobValidation.unknownFieldCount += Object.keys(record).filter((key) => !JOB_FIELDS.has(key)).length;
        const rawStatus = record.communicationStatus;
        if (
          rawStatus !== undefined
          && (typeof rawStatus !== 'string' || !LEGACY_STATUSES.includes(rawStatus as CommunicationStatus))
        ) {
          jobValidation.schemaErrorCount += 1;
          jobValidation.invalidAnonymousIds.push(anonymousId(row.id));
          legacyStatusCounts.invalid += 1;
          continue;
        }
        const normalized = withJobRecordDefaults(record as StoredJobRecord);
        const parsed = JobRecordSchema.safeParse(normalized);
        if (!parsed.success || parsed.data.id !== row.id) {
          jobValidation.schemaErrorCount += 1;
          jobValidation.invalidAnonymousIds.push(anonymousId(row.id));
          legacyStatusCounts.invalid += 1;
          continue;
        }
        legacyStatusCounts[parsed.data.communicationStatus] += 1;
      }
    }
    const v2TablesPresent = ['resume_versions', 'applications', 'feedback_events']
      .filter((table) => tableExists(db, table));
    const snapshotV1 = inspectSnapshotV1(db, paths.workspaceDirectory);
    const businessTableHashes = Object.fromEntries(
      ['profiles', 'jobs', 'import_logs'].map((table) => [table, tableHash(db, table)]),
    );
    const upgradeEligible = integrity.length === 1
      && integrity[0] === 'ok'
      && foreignKeyViolationCount === 0
      && migrationConsistent
      && schemaVersion === 1
      && jobValidation.parseErrorCount === 0
      && jobValidation.schemaErrorCount === 0
      && duplicateJobIdCount === 0
      && v2TablesPresent.length === 0;
    return {
      toolVersion: 'b7-a-v1',
      schemaVersion,
      appMetaSchemaVersion,
      migrationConsistent,
      migrationRecords,
      integrity,
      foreignKeyViolationCount,
      journalMode,
      walPresent: fs.existsSync(`${paths.sourceDatabasePath}-wal`),
      shmPresent: fs.existsSync(`${paths.sourceDatabasePath}-shm`),
      tableCounts,
      duplicateJobIdCount,
      jobValidation,
      legacyStatusCounts,
      v2TablesPresent,
      sourceFile: { sizeBytes: sourceBytes.byteLength, sha256: sha256Hex(sourceBytes) },
      businessTableHashes,
      snapshotV1,
      upgradeEligible,
    };
  } finally {
    db.close();
  }
}

export function inspectionFingerprint(report: DatabaseInspectionReport): string {
  return sha256Hex(JSON.stringify({
    schemaVersion: report.schemaVersion,
    tableCounts: report.tableCounts,
    businessTableHashes: report.businessTableHashes,
    legacyStatusCounts: report.legacyStatusCounts,
  }));
}
