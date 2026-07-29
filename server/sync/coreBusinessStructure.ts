import type Database from 'better-sqlite3';

/**
 * v2 生产底座核心业务表及关键字段，独立于 schemaVersion 数值校验，
 * 防止仅凭版本号蒙混过关。这 7 张表在 v2 引入后结构恒定（v3~v8 均为纯新增表），
 * 因此既用于当前生产只读 verifier，也用于核心业务 Snapshot 导出前的结构守卫。
 */
export const CORE_BUSINESS_V2_STRUCTURE: ReadonlyArray<{
  table: string;
  columns: readonly string[];
}> = [
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

/**
 * 只读校验核心业务 v2 结构；缺表/缺字段时抛出带 contextLabel 前缀的明确报错，
 * 避免后续读取抛出裸 SQLite 错误。contextLabel 例如「当前生产数据库」「导出源数据库」。
 */
export function assertCoreBusinessV2Structure(
  db: Database.Database,
  contextLabel: string,
): void {
  for (const { table, columns } of CORE_BUSINESS_V2_STRUCTURE) {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (exists === undefined) throw new Error(`${contextLabel}缺少 v2 核心表 ${table}`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const column of columns) {
      if (!actual.has(column)) {
        throw new Error(`${contextLabel} v2 核心表 ${table} 缺少字段 ${column}`);
      }
    }
  }
}
