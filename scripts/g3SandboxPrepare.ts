import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath, type SqliteDatabase } from '../server/db';
import { getDatabaseSchemaVersion, LATEST_SCHEMA_VERSION } from '../server/migrations';
import { initSchema } from '../server/schema';
import { sha256Hex } from '../server/sync/hash';

export const G3_SANDBOX_DIR = path.join(process.cwd(), 'tmp', 'g3-sandbox');
export const G3_SANDBOX_DB_PATH = path.join(G3_SANDBOX_DIR, 'offerflow-v4.sqlite3');

const ROW_COUNT_TABLES = [
  'profiles',
  'jobs',
  'resume_versions',
  'applications',
  'feedback_events',
  'capability_baseline_meta',
  'candidate_evidence',
  'capability_baseline_proposals',
  'capability_baseline_versions',
  'capability_command_receipts',
] as const;

export interface G3SandboxPrepareReport {
  sourceDatabasePath: string;
  sandboxDatabasePath: string;
  sourceSha256Before: string;
  sourceSha256After: string;
  sourceUnchanged: boolean;
  sandboxSchemaVersionBefore: number;
  sandboxSchemaVersionAfter: number;
  integrityOk: boolean;
  foreignKeyViolationCount: number;
  rowCounts: Record<string, { source: number; sandbox: number; matched: boolean }>;
  allRowCountsMatched: boolean;
}

function assertRealDatabaseExists(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`真实数据库不存在，无法准备 G3 沙箱：${sourcePath}`);
  }
}

function assertSandboxPathIsSafe(sandboxPath: string, sourcePath: string): void {
  const resolvedSandbox = path.resolve(sandboxPath);
  const resolvedSource = path.resolve(sourcePath);
  if (resolvedSandbox === resolvedSource) {
    throw new Error('G3 沙箱路径不得与真实数据库路径相同');
  }
  const repositoryDataDir = path.resolve(process.cwd(), 'data');
  const relativeToData = path.relative(repositoryDataDir, resolvedSandbox);
  if (relativeToData !== '' && !relativeToData.startsWith('..') && !path.isAbsolute(relativeToData)) {
    throw new Error('G3 沙箱数据库不得位于仓库 data 目录');
  }
  if (resolvedSandbox === repositoryDataDir) {
    throw new Error('G3 沙箱数据库不得位于仓库 data 目录');
  }
}

function tableRowCount(db: SqliteDatabase, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
}

function readRowCounts(db: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ROW_COUNT_TABLES) {
    counts[table] = tableRowCount(db, table);
  }
  return counts;
}

export function prepareG3Sandbox(options: {
  sourceDatabasePath?: string;
  sandboxDatabasePath?: string;
} = {}): G3SandboxPrepareReport {
  const sourceDatabasePath = options.sourceDatabasePath ?? getDbPath();
  const sandboxDatabasePath = options.sandboxDatabasePath ?? G3_SANDBOX_DB_PATH;

  assertRealDatabaseExists(sourceDatabasePath);
  assertSandboxPathIsSafe(sandboxDatabasePath, sourceDatabasePath);

  const sourceSha256Before = sha256Hex(fs.readFileSync(sourceDatabasePath));

  fs.mkdirSync(path.dirname(sandboxDatabasePath), { recursive: true });
  fs.rmSync(sandboxDatabasePath, { force: true });
  fs.rmSync(`${sandboxDatabasePath}-wal`, { force: true });
  fs.rmSync(`${sandboxDatabasePath}-shm`, { force: true });

  fs.copyFileSync(sourceDatabasePath, sandboxDatabasePath);

  const sourceSha256After = sha256Hex(fs.readFileSync(sourceDatabasePath));
  const sourceUnchanged = sourceSha256Before === sourceSha256After;
  if (!sourceUnchanged) {
    throw new Error('G3 沙箱准备过程中检测到真实数据库被修改，已中止');
  }

  const sourceDbReadonly = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  const sourceRowCounts = readRowCounts(sourceDbReadonly);
  sourceDbReadonly.close();

  const sandboxDb = new Database(sandboxDatabasePath);
  sandboxDb.pragma('journal_mode = DELETE');
  sandboxDb.pragma('foreign_keys = ON');
  const sandboxSchemaVersionBefore = getDatabaseSchemaVersion(sandboxDb);
  initSchema(sandboxDb, { targetVersion: LATEST_SCHEMA_VERSION });
  const sandboxSchemaVersionAfter = getDatabaseSchemaVersion(sandboxDb);
  if (sandboxSchemaVersionAfter !== LATEST_SCHEMA_VERSION) {
    sandboxDb.close();
    throw new Error(`G3 沙箱升级后 schema 版本不是 ${LATEST_SCHEMA_VERSION}：实际 ${sandboxSchemaVersionAfter}`);
  }

  const integrityRows = (sandboxDb.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>);
  const integrityOk = integrityRows.length === 1 && Object.values(integrityRows[0]!)[0] === 'ok';
  const foreignKeyViolationCount = (sandboxDb.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;

  const sandboxRowCounts = readRowCounts(sandboxDb);
  sandboxDb.close();

  const rowCounts: G3SandboxPrepareReport['rowCounts'] = {};
  let allRowCountsMatched = true;
  for (const table of ROW_COUNT_TABLES) {
    const source = sourceRowCounts[table] ?? 0;
    const sandbox = sandboxRowCounts[table] ?? 0;
    const matched = source === sandbox;
    if (!matched) allRowCountsMatched = false;
    rowCounts[table] = { source, sandbox, matched };
  }

  if (!integrityOk) {
    throw new Error('G3 沙箱 integrity_check 未通过');
  }
  if (foreignKeyViolationCount > 0) {
    throw new Error(`G3 沙箱 foreign_key_check 发现 ${foreignKeyViolationCount} 处违规`);
  }
  if (!allRowCountsMatched) {
    throw new Error('G3 沙箱行数与真实数据库不一致');
  }

  return {
    sourceDatabasePath,
    sandboxDatabasePath,
    sourceSha256Before,
    sourceSha256After,
    sourceUnchanged,
    sandboxSchemaVersionBefore,
    sandboxSchemaVersionAfter,
    integrityOk,
    foreignKeyViolationCount,
    rowCounts,
    allRowCountsMatched,
  };
}

function main(): void {
  const report = prepareG3Sandbox();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
