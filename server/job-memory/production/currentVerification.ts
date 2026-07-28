import Database from 'better-sqlite3';
import {
  JobRecordSchema,
  projectApplication,
} from '../../../src/domain/job-memory';
import { withJobRecordDefaults, type StoredJobRecord } from '../../../src/storage/defaults';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  PRODUCTION_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
} from '../../migrations';
import { JobRepository } from '../../repositories/jobRepository';
import {
  auditSnapshotConsistency,
  type SnapshotConsistencyReport,
} from '../../sync/consistency';
import { sha256Hex, toStableJson } from '../../sync/hash';
import { readSnapshotTable } from '../../sync/tables';
import { SYNC_TABLES, type SyncTableName } from '../../sync/types';
import { LegacyCommunicationWriteError } from '../../repositories/legacyCommunicationGuard';
import { ApplicationRepository } from '../applicationRepository';
import { FeedbackEventRepository } from '../feedbackEventRepository';
import { ResumeVersionRepository } from '../resumeVersionRepository';

export interface CurrentProductionCounts {
  profiles: number;
  jobs: number;
  resumeVersions: number;
  applications: number;
  feedbackEvents: number;
  importLogs: number;
  appMeta: number;
}

export interface CurrentProductionVerificationReport {
  /** 实际生产 schema 版本；生产底座固定为 v2，允许纯增量升级到 LATEST_SCHEMA_VERSION。 */
  schemaVersion: number;
  appMetaSchemaVersion: number;
  migrationContinuous: true;
  integrity: 'ok';
  foreignKeyViolationCount: 0;
  tableCounts: CurrentProductionCounts;
  jobSchemaInvalidCount: 0;
  resumeSchemaInvalidCount: 0;
  applicationSchemaInvalidCount: 0;
  eventSchemaInvalidCount: 0;
  projection: { valid: number; degraded: number; invalid: 0 };
  activeResumePointer: 'none' | 'active';
  orphanReferenceCount: 0;
  invalidEventTargetCount: 0;
  invalidApplicationReplacementCount: 0;
  invalidRowVersionCount: 0;
  idempotencyConflictCount: 0;
  duplicateLegacySeedCount: 0;
  unexpectedMigrationEventCount: 0;
  invalidApplicationAuditCount: 0;
  legacyWriteGuard: true;
  snapshotSchemaVersion: 2 | null;
  snapshotDifferenceCount: number;
  snapshotConsistent: boolean;
  normalizedFingerprintShort: string;
  normalizedFingerprintUnchanged: true;
  tableCountsUnchanged: true;
  verifierBusinessWrites: 0;
}

export interface CurrentProductionVerificationOptions {
  requireSnapshotConsistency?: boolean;
  snapshotDirectory?: string;
  /** Test-only hook used to prove concurrent mutations are detected. */
  afterValidation?: () => void;
}

interface DatabaseState {
  normalizedFingerprint: string;
  tableCounts: CurrentProductionCounts;
}

function firstColumn(row: Record<string, unknown>): string {
  const key = Object.keys(row)[0];
  return String(key === undefined ? '' : row[key]);
}

function tableCount(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
}

function readCounts(db: Database.Database): CurrentProductionCounts {
  return {
    profiles: tableCount(db, 'profiles'),
    jobs: tableCount(db, 'jobs'),
    resumeVersions: tableCount(db, 'resume_versions'),
    applications: tableCount(db, 'applications'),
    feedbackEvents: tableCount(db, 'feedback_events'),
    importLogs: tableCount(db, 'import_logs'),
    appMeta: tableCount(db, 'app_meta'),
  };
}

export function captureCurrentProductionState(databasePath: string): DatabaseState {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    const tables = Object.fromEntries(SYNC_TABLES.map((table) => [
      table,
      readSnapshotTable(db, table as SyncTableName),
    ]));
    const migrations = db.prepare(
      'SELECT version, name, applied_at FROM schema_migrations ORDER BY version',
    ).all();
    return {
      normalizedFingerprint: sha256Hex(toStableJson({ tables, migrations })),
      tableCounts: readCounts(db),
    };
  } finally {
    db.close();
  }
}

function countSnapshotDifferences(report: SnapshotConsistencyReport): number {
  return Object.values(report.tables).reduce((sum, table) => (
    sum + table.onlyInDatabase.length + table.onlyInSnapshot.length + table.changed.length
  ), 0);
}

function validateLegacyWriteGuard(db: Database.Database): true {
  const row = db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: string } | undefined;
  if (row === undefined) return true;
  try {
    new JobRepository(db, { legacyCommunicationWriteDisabled: true }).patch(row.id, {
      communicationStatus: 'replied',
    });
  } catch (error) {
    if (error instanceof LegacyCommunicationWriteError) return true;
    throw error;
  }
  throw new Error('Job legacy 流程字段写入门禁未生效');
}

function assertZero(value: number, message: string): 0 {
  if (value !== 0) throw new Error(message);
  return 0;
}

/** v2 生产底座必须存在的核心表及其关键字段，独立于 schemaVersion 数值校验，防止只靠版本号蒙混过关。 */
const V2_CORE_STRUCTURE: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'app_meta', columns: ['key', 'value', 'updated_at'] },
  { table: 'profiles', columns: ['id', 'data_json'] },
  { table: 'jobs', columns: ['id', 'data_json'] },
  { table: 'import_logs', columns: ['id'] },
  { table: 'resume_versions', columns: ['id', 'content_hash', 'idempotency_key', 'row_version'] },
  {
    table: 'applications',
    columns: ['id', 'job_id', 'migration_key', 'superseded_by_application_id', 'idempotency_key', 'row_version'],
  },
  {
    table: 'feedback_events',
    columns: ['id', 'application_id', 'event_type', 'target_event_id', 'idempotency_key'],
  },
];

function assertV2CoreStructure(db: Database.Database): void {
  for (const { table, columns } of V2_CORE_STRUCTURE) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (exists === undefined) throw new Error(`当前生产数据库缺少 v2 核心表 ${table}`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const column of columns) {
      if (!actual.has(column)) {
        throw new Error(`当前生产数据库 v2 核心表 ${table} 缺少字段 ${column}`);
      }
    }
  }
}

export function verifyCurrentProductionDatabase(
  databasePath: string,
  options: CurrentProductionVerificationOptions = {},
): CurrentProductionVerificationReport {
  const requireSnapshotConsistency = options.requireSnapshotConsistency ?? true;
  // 先做只读结构守卫：核心表/字段缺失时给出明确报错，避免 captureCurrentProductionState 抛出裸 SQLite 错误。
  const structureDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    structureDb.pragma('query_only = ON');
    assertV2CoreStructure(structureDb);
  } finally {
    structureDb.close();
  }
  const before = captureCurrentProductionState(databasePath);
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  let partial: Omit<
    CurrentProductionVerificationReport,
    | 'snapshotSchemaVersion'
    | 'snapshotDifferenceCount'
    | 'snapshotConsistent'
    | 'normalizedFingerprintShort'
    | 'normalizedFingerprintUnchanged'
    | 'tableCountsUnchanged'
    | 'verifierBusinessWrites'
  >;
  try {
    db.pragma('query_only = ON');
    // getDatabaseSchemaVersion 已校验 migration 无缺口、无乱序、无未知未来版本、名称一致。
    const schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion < PRODUCTION_SCHEMA_VERSION || schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `当前生产数据库 schema 应在 ${PRODUCTION_SCHEMA_VERSION}~${LATEST_SCHEMA_VERSION} 之间，实际为 ${schemaVersion}`,
      );
    }
    // 生产底座恒为 v2：核心表/字段已在上方只读守卫校验；下方 migration 连续性再校验前两条核心 migration 名称，禁止仅凭版本号通过。
    const integrityRows = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map(firstColumn);
    if (integrityRows.length !== 1 || integrityRows[0] !== 'ok') {
      throw new Error('当前生产数据库 integrity_check 失败');
    }
    const foreignKeyViolationCount = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    if (foreignKeyViolationCount !== 0) throw new Error('当前生产数据库存在外键违规');

    const migrations = db.prepare(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number; name: string }>;
    // 生产底座固定在 PRODUCTION_SCHEMA_VERSION（v2），但允许纯增量升级到实际 schemaVersion。
    // 校验实际版本对应的前 schemaVersion 条 migration 全部连续、版本递增且名称与代码已知定义一致；
    // 这天然覆盖前两条核心 migration，禁止只靠 version >= 2 通过。
    const expectedMigrations = SCHEMA_MIGRATIONS.slice(0, schemaVersion);
    const migrationContinuous = migrations.length === expectedMigrations.length
      && migrations.every((row, index) => (
        row.version === index + 1 && row.name === expectedMigrations[index]?.name
      ));
    if (!migrationContinuous) throw new Error('当前生产数据库 migration 不连续或名称不匹配');
    const appMetaSchema = db.prepare(
      "SELECT value FROM app_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined;
    if (appMetaSchema?.value !== String(schemaVersion)) {
      throw new Error('app_meta schema_version 与 migration 不一致');
    }

    const jobRows = db.prepare('SELECT data_json FROM jobs ORDER BY id').all() as Array<{
      data_json: string;
    }>;
    for (const row of jobRows) {
      JobRecordSchema.parse(withJobRecordDefaults(JSON.parse(row.data_json) as StoredJobRecord));
    }
    const resumeRepository = new ResumeVersionRepository(db);
    const resumeVersions = resumeRepository.listResumeVersions();
    const applications = new ApplicationRepository(db).listApplications();
    const eventRepository = new FeedbackEventRepository(db);
    const projection = { valid: 0, degraded: 0, invalid: 0 };
    let eventCount = 0;
    for (const application of applications) {
      const events = eventRepository.listEventsByApplication(application.id);
      eventCount += events.length;
      projection[projectApplication(application, events).projectionStatus] += 1;
    }
    if (eventCount !== before.tableCounts.feedbackEvents) {
      throw new Error('FeedbackEvent 读取数量与数据库聚合不一致');
    }
    if (projection.invalid !== 0) throw new Error('当前生产数据库存在 invalid ApplicationProjection');

    const active = db.prepare(`
      SELECT meta.value AS id, resume.archived_at AS archivedAt
      FROM app_meta meta
      LEFT JOIN resume_versions resume ON resume.id = meta.value
      WHERE meta.key = 'active_resume_version_id'
    `).get() as { id: string; archivedAt: number | null } | undefined;
    if (active !== undefined && (active.id.trim() === '' || active.archivedAt !== null)) {
      throw new Error('active ResumeVersion pointer 指向不存在或已归档版本');
    }
    if (active !== undefined && !resumeVersions.some((resume) => resume.id === active.id)) {
      throw new Error('active ResumeVersion pointer 指向不存在或已归档版本');
    }

    const invalidEventTargetCount = assertZero(Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM feedback_events void_event
      LEFT JOIN feedback_events target ON target.id = void_event.target_event_id
      WHERE void_event.event_type = 'event_voided'
        AND (
          target.id IS NULL
          OR target.application_id <> void_event.application_id
          OR target.event_type = 'event_voided'
          OR json_extract(void_event.payload_json, '$.targetEventId') <> void_event.target_event_id
          OR json_extract(void_event.payload_json, '$.targetEventType') <> target.event_type
        )
    `).get() as { count: number }).count), '当前生产数据库存在非法 Event void target');

    const invalidApplicationReplacementCount = assertZero(Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM applications source
      LEFT JOIN applications replacement ON replacement.id = source.superseded_by_application_id
      WHERE source.superseded_by_application_id IS NOT NULL
        AND (
          source.voided_at IS NULL
          OR replacement.id IS NULL
          OR replacement.job_id <> source.job_id
          OR replacement.voided_at IS NOT NULL
        )
    `).get() as { count: number }).count), '当前生产数据库存在非法 Application replacement 引用');

    const invalidRowVersionCount = assertZero(Number((db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM resume_versions WHERE typeof(row_version) <> 'integer' OR row_version < 1)
        + (SELECT COUNT(*) FROM applications WHERE typeof(row_version) <> 'integer' OR row_version < 1)
        AS count
    `).get() as { count: number }).count), '当前生产数据库存在非法 rowVersion');

    const idempotencyConflictCount = assertZero(Number((db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM (
          SELECT idempotency_key FROM resume_versions GROUP BY idempotency_key HAVING COUNT(*) > 1
        ))
        + (SELECT COUNT(*) FROM (
          SELECT idempotency_key FROM applications GROUP BY idempotency_key HAVING COUNT(*) > 1
        ))
        + (SELECT COUNT(*) FROM (
          SELECT idempotency_key FROM feedback_events GROUP BY idempotency_key HAVING COUNT(*) > 1
        )) AS count
    `).get() as { count: number }).count), '当前生产数据库存在 idempotencyKey/requestHash 冲突');

    const duplicateLegacySeedCount = assertZero(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT application_id
        FROM feedback_events
        WHERE event_type = 'legacy_status_imported'
        GROUP BY application_id
        HAVING COUNT(*) > 1
      )
    `).get() as { count: number }).count), '当前生产数据库存在重复 legacy_status_imported seed');

    const unexpectedMigrationEventCount = assertZero(Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM feedback_events
      WHERE recorded_by = 'system_migration' AND event_type <> 'legacy_status_imported'
    `).get() as { count: number }).count), '当前生产数据库存在异常自动 migration Event');

    const invalidApplicationAuditCount = assertZero(Number((db.prepare(`
      SELECT COUNT(*) AS count FROM applications application
      WHERE (
        application.migration_key IS NULL
        AND 1 <> (
          SELECT COUNT(*) FROM feedback_events event
          WHERE event.application_id = application.id AND event.event_type = 'application_created'
        )
      ) OR (
        application.migration_key IS NOT NULL
        AND 1 <> (
          SELECT COUNT(*) FROM feedback_events event
          WHERE event.application_id = application.id AND event.event_type = 'legacy_status_imported'
        )
      )
    `).get() as { count: number }).count), '当前生产数据库 Application 审计事件与来源不一致');

    const orphanReferenceCount = foreignKeyViolationCount;
    partial = {
      schemaVersion,
      appMetaSchemaVersion: schemaVersion,
      migrationContinuous: true,
      integrity: 'ok',
      foreignKeyViolationCount: 0,
      tableCounts: before.tableCounts,
      jobSchemaInvalidCount: 0,
      resumeSchemaInvalidCount: 0,
      applicationSchemaInvalidCount: 0,
      eventSchemaInvalidCount: 0,
      projection: { valid: projection.valid, degraded: projection.degraded, invalid: 0 },
      activeResumePointer: active === undefined ? 'none' : 'active',
      orphanReferenceCount,
      invalidEventTargetCount,
      invalidApplicationReplacementCount,
      invalidRowVersionCount,
      idempotencyConflictCount,
      duplicateLegacySeedCount,
      unexpectedMigrationEventCount,
      invalidApplicationAuditCount,
      legacyWriteGuard: validateLegacyWriteGuard(db),
    };
  } finally {
    db.close();
  }

  let snapshotSchemaVersion: 2 | null = null;
  let snapshotDifferenceCount = 0;
  let snapshotConsistent = false;
  if (requireSnapshotConsistency) {
    const snapshot = auditSnapshotConsistency(databasePath, options.snapshotDirectory);
    snapshotSchemaVersion = snapshot.snapshotSchemaVersion === 2 ? 2 : null;
    snapshotDifferenceCount = countSnapshotDifferences(snapshot);
    snapshotConsistent = snapshot.ok && snapshotSchemaVersion === 2;
    if (!snapshotConsistent) throw new Error('正式 Snapshot 与当前生产数据库不一致');
  }

  options.afterValidation?.();
  const after = captureCurrentProductionState(databasePath);
  if (after.normalizedFingerprint !== before.normalizedFingerprint) {
    throw new Error('生产验证运行期间数据库规范化指纹发生变化');
  }
  if (JSON.stringify(after.tableCounts) !== JSON.stringify(before.tableCounts)) {
    throw new Error('生产验证运行期间数据库聚合发生变化');
  }
  return {
    ...partial,
    snapshotSchemaVersion,
    snapshotDifferenceCount,
    snapshotConsistent,
    normalizedFingerprintShort: before.normalizedFingerprint.slice(0, 12),
    normalizedFingerprintUnchanged: true,
    tableCountsUnchanged: true,
    verifierBusinessWrites: 0,
  };
}
