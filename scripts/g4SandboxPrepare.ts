import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath, type SqliteDatabase } from '../server/db';
import { getDatabaseSchemaVersion, MARKET_POSITION_SCHEMA_VERSION } from '../server/migrations';
import { initSchema } from '../server/schema';
import { sha256Hex } from '../server/sync/hash';

export const G4_SANDBOX_DIR = path.join(process.cwd(), 'tmp', 'g4-sandbox');
export const G4_SANDBOX_DB_PATH = path.join(G4_SANDBOX_DIR, 'offerflow-v5.sqlite3');

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
  'market_position_meta',
  'market_position_proposals',
  'market_position_versions',
  'market_position_receipts',
] as const;

export interface G4SandboxPrepareReport {
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
    throw new Error(`真实数据库不存在，无法准备 G4 沙箱：${sourcePath}`);
  }
}

function assertSandboxPathIsSafe(sandboxPath: string, sourcePath: string): void {
  const resolvedSandbox = path.resolve(sandboxPath);
  const resolvedSource = path.resolve(sourcePath);
  if (resolvedSandbox === resolvedSource) {
    throw new Error('G4 沙箱路径不得与真实数据库路径相同');
  }
  const repositoryDataDir = path.resolve(process.cwd(), 'data');
  const relativeToData = path.relative(repositoryDataDir, resolvedSandbox);
  if (relativeToData !== '' && !relativeToData.startsWith('..') && !path.isAbsolute(relativeToData)) {
    throw new Error('G4 沙箱数据库不得位于仓库 data 目录');
  }
  if (resolvedSandbox === repositoryDataDir) {
    throw new Error('G4 沙箱数据库不得位于仓库 data 目录');
  }
}

/**
 * 表可能不存在于真实数据库（schema v2 上没有 v3/v4/v5 新增表）。
 * 与 G3 沙箱一致：源库缺表按 0 计数，避免误判为不一致。
 */
function tableRowCountOrZero(db: SqliteDatabase, table: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return 0;
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count);
}

function readRowCounts(db: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of ROW_COUNT_TABLES) {
    counts[table] = tableRowCountOrZero(db, table);
  }
  return counts;
}

export function prepareG4Sandbox(options: {
  sourceDatabasePath?: string;
  sandboxDatabasePath?: string;
} = {}): G4SandboxPrepareReport {
  const sourceDatabasePath = options.sourceDatabasePath ?? getDbPath();
  const sandboxDatabasePath = options.sandboxDatabasePath ?? G4_SANDBOX_DB_PATH;

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
    throw new Error('G4 沙箱准备过程中检测到真实数据库被修改，已中止');
  }

  const sourceDbReadonly = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  const sourceRowCounts = readRowCounts(sourceDbReadonly);
  sourceDbReadonly.close();

  const sandboxDb = new Database(sandboxDatabasePath);
  sandboxDb.pragma('journal_mode = DELETE');
  sandboxDb.pragma('foreign_keys = ON');
  const sandboxSchemaVersionBefore = getDatabaseSchemaVersion(sandboxDb);
  initSchema(sandboxDb, { targetVersion: MARKET_POSITION_SCHEMA_VERSION });
  const sandboxSchemaVersionAfter = getDatabaseSchemaVersion(sandboxDb);
  if (sandboxSchemaVersionAfter !== MARKET_POSITION_SCHEMA_VERSION) {
    sandboxDb.close();
    throw new Error(`G4 沙箱升级后 schema 版本不是 ${MARKET_POSITION_SCHEMA_VERSION}：实际 ${sandboxSchemaVersionAfter}`);
  }

  const integrityRows = (sandboxDb.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>);
  const integrityOk = integrityRows.length === 1 && Object.values(integrityRows[0]!)[0] === 'ok';
  const foreignKeyViolationCount = (sandboxDb.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;

  const sandboxRowCounts = readRowCounts(sandboxDb);
  sandboxDb.close();

  const rowCounts: G4SandboxPrepareReport['rowCounts'] = {};
  let allRowCountsMatched = true;
  for (const table of ROW_COUNT_TABLES) {
    const source = sourceRowCounts[table] ?? 0;
    const sandbox = sandboxRowCounts[table] ?? 0;
    const matched = source === sandbox;
    if (!matched) allRowCountsMatched = false;
    rowCounts[table] = { source, sandbox, matched };
  }

  if (!integrityOk) {
    throw new Error('G4 沙箱 integrity_check 未通过');
  }
  if (foreignKeyViolationCount > 0) {
    throw new Error(`G4 沙箱 foreign_key_check 发现 ${foreignKeyViolationCount} 处违规`);
  }
  if (!allRowCountsMatched) {
    throw new Error('G4 沙箱行数与真实数据库不一致');
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
  const report = prepareG4Sandbox();
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
