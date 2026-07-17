/**
 * v0.7 当前生产只读验证（schema v3）。
 *
 * 与"历史 v2 升级 attestation"分离：后者继续验证当时的 v2 结果，本命令验证当前真实库在 v3 下的健康：
 * - schema 恰为最新 LATEST_SCHEMA_VERSION；
 * - integrity_check ok、外键无违规；
 * - migration 连续且名称与注册一致（[1,2,3]）；
 * - Job Memory v2 核心表仍存在；
 * - G2 能力基线新表存在；
 * - verifierBusinessWrites=0：验证前后数据库文件 SHA-256 不变（只读，不写入）；
 * - 打印行数仅供参考，不作为永久门禁。
 * 不发布 Snapshot。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { getDbPath } from '../server/db';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
} from '../server/migrations';

const JOB_MEMORY_TABLES = ['profiles', 'jobs', 'resume_versions', 'applications', 'feedback_events'] as const;
const CAPABILITY_TABLES = [
  'capability_baseline_meta',
  'candidate_evidence',
  'capability_baseline_proposals',
  'capability_baseline_versions',
  'capability_command_receipts',
] as const;

function argValue(name: string): string | undefined {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) return next;
  }
  return undefined;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function tablePresent(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function main(): void {
  const source = argValue('source') ?? getDbPath();
  if (!fs.existsSync(source)) {
    console.error(`真实数据库不存在：${source}`);
    process.exitCode = 1;
    return;
  }

  const fingerprintBefore = sha256File(source);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  const problems: string[] = [];
  let schemaVersion = 0;
  const counts: Record<string, number> = {};
  try {
    db.pragma('query_only = ON');
    schemaVersion = getDatabaseSchemaVersion(db);
    if (schemaVersion !== LATEST_SCHEMA_VERSION) {
      problems.push(`schema 版本应为 ${LATEST_SCHEMA_VERSION}，实际 ${schemaVersion}`);
    }
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map((row) => Object.values(row)[0]);
    if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push('integrity_check 未通过');
    if ((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length !== 0) {
      problems.push('存在外键违规');
    }

    const migrations = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    const continuous = migrations.length === SCHEMA_MIGRATIONS.length
      && migrations.every((row, index) => (
        row.version === index + 1 && row.name === SCHEMA_MIGRATIONS[index]?.name
      ));
    if (!continuous) problems.push('migration 不连续或名称与注册不一致');

    for (const table of [...JOB_MEMORY_TABLES, ...CAPABILITY_TABLES]) {
      if (!tablePresent(db, table)) {
        problems.push(`缺少表 ${table}`);
      } else {
        counts[table] = (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
      }
    }
  } finally {
    db.close();
  }

  const fingerprintAfter = sha256File(source);
  const verifierBusinessWrites = fingerprintBefore === fingerprintAfter ? 0 : 1;
  if (verifierBusinessWrites !== 0) problems.push('验证过程改变了数据库文件（verifier 不应写入）');

  const ok = problems.length === 0;
  console.log(JSON.stringify({
    ok,
    source,
    schemaVersion,
    fingerprintBefore,
    fingerprintAfter,
    verifierBusinessWrites,
    tableCounts: counts,
    problems,
    snapshotPublished: false,
    note: '当前 v3 只读验证；历史 v2 升级 attestation 由 job-memory-v2:verify-upgrade-attestation 单独保留。',
  }, null, 2));
  if (!ok) process.exitCode = 1;
}

main();
