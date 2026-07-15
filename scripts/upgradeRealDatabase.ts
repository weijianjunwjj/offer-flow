/**
 * 显式升级真实数据库到最新 schema（v0.7 G2：v2 → v3）。
 *
 * 本命令是唯一被允许升级真实 data/offerflow.sqlite3 的入口；服务启动不会自动迁移真实库。
 * 安全要求：
 * - 升级前对源库做只读文件级备份并校验 hash；
 * - 支持 --expected-source-fingerprint 预期指纹校验；
 * - 需要显式 --confirm 才会真正写入；不带 --confirm 时只打印计划（dry-run）；
 * - 升级后做只读校验（schema、完整性、外键、核心表行数不减）；
 * - 不发布 Snapshot。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath, openDb } from '../server/db';
import {
  getDatabaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  runMigrations,
} from '../server/migrations';

const CORE_TABLES = ['profiles', 'jobs', 'resume_versions', 'applications', 'feedback_events'] as const;

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

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function tableCounts(db: Database.Database, tables: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const present = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(table);
    counts[table] = present === undefined
      ? -1
      : (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }
  return counts;
}

function main(): void {
  const source = argValue('source') ?? getDbPath();
  const confirm = hasFlag('confirm');
  const expectedFingerprint = argValue('expected-source-fingerprint');
  const backupDir = argValue('backup-dir') ?? path.join(process.cwd(), 'backups', 'capability-baseline');

  if (!fs.existsSync(source)) {
    console.error(`源数据库不存在：${source}`);
    process.exitCode = 1;
    return;
  }

  const probe = new Database(source, { readonly: true, fileMustExist: true });
  let fromVersion: number;
  let preCounts: Record<string, number>;
  try {
    fromVersion = getDatabaseSchemaVersion(probe);
    preCounts = tableCounts(probe, CORE_TABLES);
  } finally {
    probe.close();
  }

  const sourceFingerprint = sha256File(source);
  if (expectedFingerprint !== undefined && !sourceFingerprint.startsWith(expectedFingerprint)) {
    console.error(
      `源库指纹不匹配：期望以 ${expectedFingerprint} 开头，实际 ${sourceFingerprint.slice(0, 16)}…；已中止。`,
    );
    process.exitCode = 1;
    return;
  }

  if (fromVersion === LATEST_SCHEMA_VERSION) {
    console.log(JSON.stringify({
      action: 'noop', source, fromVersion, targetVersion: LATEST_SCHEMA_VERSION,
      sourceFingerprint, message: '真实库已是最新 schema，无需升级。',
    }, null, 2));
    return;
  }

  if (!confirm) {
    console.log(JSON.stringify({
      action: 'dry-run', source, fromVersion, targetVersion: LATEST_SCHEMA_VERSION,
      sourceFingerprint, preCounts,
      note: '未带 --confirm，未做任何写入。确认后请运行：npm run db:upgrade-real -- --confirm',
    }, null, 2));
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `offerflow-pre-v${LATEST_SCHEMA_VERSION}-${stamp}.sqlite3`);
  fs.copyFileSync(source, backupPath);
  const backupFingerprint = sha256File(backupPath);
  if (backupFingerprint !== sourceFingerprint) {
    console.error('备份 hash 与源库不一致，已中止升级。');
    process.exitCode = 1;
    return;
  }

  const db = openDb(source);
  let toVersion: number;
  let postCounts: Record<string, number>;
  let integrityOk: boolean;
  let foreignKeyViolations: number;
  try {
    runMigrations(db, { targetVersion: LATEST_SCHEMA_VERSION });
    toVersion = getDatabaseSchemaVersion(db);
    const integrity = (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>)
      .map((row) => Object.values(row)[0]);
    integrityOk = integrity.length === 1 && integrity[0] === 'ok';
    foreignKeyViolations = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    postCounts = tableCounts(db, CORE_TABLES);
  } finally {
    db.close();
  }

  const countsPreserved = CORE_TABLES.every((table) => postCounts[table]! >= preCounts[table]!);
  const verifyOk = toVersion === LATEST_SCHEMA_VERSION && integrityOk && foreignKeyViolations === 0 && countsPreserved;

  console.log(JSON.stringify({
    action: 'upgraded', source, fromVersion, toVersion,
    sourceFingerprint, backupPath, backupFingerprint,
    integrityOk, foreignKeyViolations, preCounts, postCounts, countsPreserved,
    snapshotPublished: false, verifyOk,
  }, null, 2));
  if (!verifyOk) process.exitCode = 1;
}

main();
