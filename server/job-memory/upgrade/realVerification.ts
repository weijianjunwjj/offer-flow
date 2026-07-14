import Database from 'better-sqlite3';
import {
  JobRecordSchema,
  projectApplication,
} from '../../../src/domain/job-memory';
import { withJobRecordDefaults, type StoredJobRecord } from '../../../src/storage/defaults';
import { getDatabaseSchemaVersion } from '../../migrations';
import { sha256Hex } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import type { SnapshotTable, SyncTableName } from '../../sync/types';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import type { JobMemoryV2BackupManifest } from './backup';

export const B7B_UPGRADE_META_KEY = 'job_memory_v2_upgrade_result';

export interface B7BUpgradeMarker {
  version: 1;
  approvedBackupId: string;
  applyGitCommit: string;
  sourceFingerprintShort: string;
  appliedAt: string;
  createdApplications: 7;
  createdEvents: 7;
  skipCount: 6;
  manualReviewCount: 0;
  projection: { valid: 0; degraded: 7; invalid: 0 };
  secondRun: { createdApplications: 0; createdEvents: 0; auditLogCreated: false };
  jobHashChanges: 0;
}

export interface RealUpgradeVerificationReport {
  schemaVersion: number;
  migrationContinuous: boolean;
  integrity: string[];
  foreignKeyViolationCount: number;
  tableCounts: {
    profiles: number;
    jobs: number;
    originalImportLogs: number;
    migrationAuditLogs: number;
    resumeVersions: number;
    applications: number;
    feedbackEvents: number;
  };
  projection: { valid: number; degraded: number; invalid: number };
  skipCount: number;
  manualReviewCount: number;
  secondRun: B7BUpgradeMarker['secondRun'];
  jobHashChanges: number;
  profileHashChanges: number;
  originalImportLogHashChanges: number;
  legacyFieldChanges: number;
  weakLegacySeedCount: number;
  notContactedApplicationCount: number;
  pausedWithoutInteractionApplicationCount: number;
  applicationsWithResumeVersion: number;
  applicationsWithFabricatedContext: number;
  nonLegacySeedEventCount: number;
  activeResumeVersionId: string | null;
  marker: B7BUpgradeMarker;
}

function firstColumn(row: Record<string, unknown>): string {
  const key = Object.keys(row)[0];
  return String(key === undefined ? '' : row[key]);
}

function tableCount(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
}

function snapshotHash(table: SnapshotTable): string {
  return sha256Hex(JSON.stringify(table));
}

function readOriginalImportLogs(db: Database.Database): SnapshotTable {
  const table = readSnapshotTable(db, 'import_logs' as SyncTableName);
  return {
    ...table,
    rows: table.rows.filter((row) => row.source !== 'job-memory-v2-backfill'),
  };
}

function parseMarker(db: Database.Database): B7BUpgradeMarker {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(B7B_UPGRADE_META_KEY) as {
    value: string;
  } | undefined;
  if (row === undefined) throw new Error('缺少 B7-B 正式升级标记');
  const marker = JSON.parse(row.value) as B7BUpgradeMarker;
  if (
    marker.version !== 1
    || typeof marker.approvedBackupId !== 'string'
    || typeof marker.applyGitCommit !== 'string'
    || typeof marker.sourceFingerprintShort !== 'string'
  ) throw new Error('B7-B 正式升级标记无效');
  return marker;
}

function hasInteractionEvidence(job: ReturnType<typeof JobRecordSchema.parse>): boolean {
  return ['greeted_unread', 'greeted_read_no_reply', 'replied', 'interviewing']
    .includes(job.communicationStatus)
    || job.lastGreetedAt !== undefined
    || job.lastFollowupAt !== undefined
    || job.followupCount > 0;
}

export function verifyRealUpgradeDatabase(
  databasePath: string,
  approvedManifest: JobMemoryV2BackupManifest,
): RealUpgradeVerificationReport {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const schemaVersion = getDatabaseSchemaVersion(db);
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map(firstColumn);
    const foreignKeyViolationCount = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    const migrationRows = db.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    const migrationContinuous = migrationRows.every((row, index) => row.version === index + 1)
      && migrationRows.at(-1)?.version === 2;
    const marker = parseMarker(db);

    const applications = new ApplicationRepository(db).listApplications();
    const eventRepository = new FeedbackEventRepository(db);
    const projection = { valid: 0, degraded: 0, invalid: 0 };
    for (const application of applications) {
      projection[projectApplication(
        application,
        eventRepository.listEventsByApplication(application.id),
      ).projectionStatus] += 1;
    }

    const jobs = (db.prepare('SELECT id, data_json FROM jobs ORDER BY id').all() as Array<{
      id: string;
      data_json: string;
    }>).map((row) => ({
      id: row.id,
      job: JobRecordSchema.parse(withJobRecordDefaults(JSON.parse(row.data_json) as StoredJobRecord)),
    }));
    const applicationCounts = new Map((db.prepare(
      'SELECT job_id AS jobId, COUNT(*) AS count FROM applications GROUP BY job_id',
    ).all() as Array<{ jobId: string; count: number }>).map((row) => [row.jobId, row.count]));
    const notContactedApplicationCount = jobs
      .filter(({ job }) => job.communicationStatus === 'not_contacted')
      .reduce((sum, row) => sum + (applicationCounts.get(row.id) ?? 0), 0);
    const pausedWithoutInteractionApplicationCount = jobs
      .filter(({ job }) => job.communicationStatus === 'paused' && !hasInteractionEvidence(job))
      .reduce((sum, row) => sum + (applicationCounts.get(row.id) ?? 0), 0);

    const weakLegacySeedCount = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM feedback_events
      WHERE event_type = 'legacy_status_imported'
        AND recorded_by = 'system_migration'
        AND source_confidence = 'inferred'
        AND evidence_level = 'weak'
        AND event_at IS NULL
        AND time_precision = 'unknown'
    `).get() as { count: number }).count);
    const nonLegacySeedEventCount = Number((db.prepare(
      "SELECT COUNT(*) AS count FROM feedback_events WHERE event_type <> 'legacy_status_imported'",
    ).get() as { count: number }).count);
    const applicationsWithResumeVersion = Number((db.prepare(
      'SELECT COUNT(*) AS count FROM applications WHERE resume_version_id IS NOT NULL',
    ).get() as { count: number }).count);
    const applicationsWithFabricatedContext = Number((db.prepare(`
      SELECT COUNT(*) AS count FROM applications
      WHERE primary_contact_json IS NOT NULL
         OR recruiting_entity_name IS NOT NULL
         OR employer_group_key IS NOT NULL
         OR end_client_name IS NOT NULL
         OR market_city IS NOT NULL
         OR origin <> 'unknown'
         OR channel <> 'unknown'
    `).get() as { count: number }).count);

    const jobHash = snapshotHash(readSnapshotTable(db, 'jobs' as SyncTableName));
    const profileHash = snapshotHash(readSnapshotTable(db, 'profiles' as SyncTableName));
    const originalImportLogHash = snapshotHash(readOriginalImportLogs(db));
    const activeResumeVersionId = (db.prepare(
      "SELECT value FROM app_meta WHERE key = 'active_resume_version_id'",
    ).get() as { value: string } | undefined)?.value ?? null;
    const tableCounts = {
      profiles: tableCount(db, 'profiles'),
      jobs: tableCount(db, 'jobs'),
      originalImportLogs: Number((db.prepare(
        "SELECT COUNT(*) AS count FROM import_logs WHERE source <> 'job-memory-v2-backfill'",
      ).get() as { count: number }).count),
      migrationAuditLogs: Number((db.prepare(
        "SELECT COUNT(*) AS count FROM import_logs WHERE source = 'job-memory-v2-backfill'",
      ).get() as { count: number }).count),
      resumeVersions: tableCount(db, 'resume_versions'),
      applications: tableCount(db, 'applications'),
      feedbackEvents: tableCount(db, 'feedback_events'),
    };

    const report: RealUpgradeVerificationReport = {
      schemaVersion,
      migrationContinuous,
      integrity,
      foreignKeyViolationCount,
      tableCounts,
      projection,
      skipCount: marker.skipCount,
      manualReviewCount: marker.manualReviewCount,
      secondRun: marker.secondRun,
      jobHashChanges: jobHash === approvedManifest.sourceDatabase.businessTableHashes.jobs ? 0 : 1,
      profileHashChanges: profileHash === approvedManifest.sourceDatabase.businessTableHashes.profiles ? 0 : 1,
      originalImportLogHashChanges: originalImportLogHash
        === approvedManifest.sourceDatabase.businessTableHashes.import_logs ? 0 : 1,
      legacyFieldChanges: jobHash === approvedManifest.sourceDatabase.businessTableHashes.jobs ? 0 : 1,
      weakLegacySeedCount,
      notContactedApplicationCount,
      pausedWithoutInteractionApplicationCount,
      applicationsWithResumeVersion,
      applicationsWithFabricatedContext,
      nonLegacySeedEventCount,
      activeResumeVersionId,
      marker,
    };
    assertExpectedRealUpgrade(report);
    return report;
  } finally {
    db.close();
  }
}

export function assertExpectedRealUpgrade(report: RealUpgradeVerificationReport): void {
  const valid = report.schemaVersion === 2
    && report.migrationContinuous
    && report.integrity.length === 1
    && report.integrity[0] === 'ok'
    && report.foreignKeyViolationCount === 0
    && report.tableCounts.jobs === 13
    && report.tableCounts.profiles === 1
    && report.tableCounts.originalImportLogs === 1
    && report.tableCounts.migrationAuditLogs === 1
    && report.tableCounts.resumeVersions === 0
    && report.tableCounts.applications === 7
    && report.tableCounts.feedbackEvents === 7
    && report.skipCount === 6
    && report.manualReviewCount === 0
    && report.projection.valid === 0
    && report.projection.degraded === 7
    && report.projection.invalid === 0
    && report.secondRun.createdApplications === 0
    && report.secondRun.createdEvents === 0
    && !report.secondRun.auditLogCreated
    && report.jobHashChanges === 0
    && report.profileHashChanges === 0
    && report.originalImportLogHashChanges === 0
    && report.legacyFieldChanges === 0
    && report.weakLegacySeedCount === 7
    && report.notContactedApplicationCount === 0
    && report.pausedWithoutInteractionApplicationCount === 0
    && report.applicationsWithResumeVersion === 0
    && report.applicationsWithFabricatedContext === 0
    && report.nonLegacySeedEventCount === 0
    && report.activeResumeVersionId === null;
  if (!valid) throw new Error('B7-B 正式升级结果未通过硬断言');
}
