import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath, openDb, type SqliteDatabase } from '../server/db';
import { getDatabaseSchemaVersion, STRATEGY_WINDOW_SCHEMA_VERSION } from '../server/migrations';
import { initSchema } from '../server/schema';
import { sha256Hex } from '../server/sync/hash';

export const G5_SANDBOX_DIR = path.join(process.cwd(), 'tmp', 'g5-sandbox');
export const G5_SANDBOX_DB_PATH = path.join(G5_SANDBOX_DIR, 'offerflow-v6.sqlite3');
// G5 沙箱从已验收的 G4 沙箱 v5 副本创建，而不是直接从真实库创建：
// 这样 G5 可以复用 G4 中已建立并激活的市场位置版本作为策略窗口的输入。
export const G4_SANDBOX_SOURCE_DB_PATH = path.join(process.cwd(), 'tmp', 'g4-sandbox', 'offerflow-v5.sqlite3');

const EXPECTED_SOURCE_SCHEMA_VERSION = 5;

// G1~G4 关键表：源库（G4 sandbox v5）与副本行数须保持一致。
// strategy_* 为 G5 v6 新增表，在源库不存在按 0 计，副本升级后应为 0。
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

// G5 v6 新增表：副本升级后必须存在且行数为 0。
const G5_NEW_TABLES = [
  'strategy_meta',
  'strategy_proposals',
  'strategy_versions',
  'strategy_receipts',
] as const;

export interface G5SandboxPrepareReport {
  sourceDatabasePath: string;
  sandboxDatabasePath: string;
  realDatabasePath: string;
  sourceSha256Before: string;
  sourceSha256After: string;
  sourceUnchanged: boolean;
  realDbSha256Before: string | null;
  realDbSha256After: string | null;
  realDbUnchanged: boolean;
  sourceSchemaVersion: number;
  sandboxSchemaVersionBefore: number;
  sandboxSchemaVersionAfter: number;
  integrityOk: boolean;
  foreignKeyViolationCount: number;
  rowCounts: Record<string, { source: number; sandbox: number; matched: boolean }>;
  allRowCountsMatched: boolean;
  newTableRowCounts: Record<string, number>;
  newTablesEmpty: boolean;
}

function assertSourceDatabaseExists(sourcePath: string): void {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `G4 沙箱源库不存在，无法准备 G5 沙箱：${sourcePath}\n` +
        '恢复步骤：先运行 `npm run g4:sandbox:prepare`（或启动 G4 沙箱），' +
        '并在 G4 沙箱中建立并激活一份正式的市场位置版本，再重试 G5 沙箱准备。',
    );
  }
}

function assertSandboxPathIsSafe(sandboxPath: string, forbiddenPaths: readonly string[]): void {
  const resolvedSandbox = path.resolve(sandboxPath);
  for (const forbidden of forbiddenPaths) {
    if (resolvedSandbox === path.resolve(forbidden)) {
      throw new Error('G5 沙箱路径不得与源库或真实数据库路径相同');
    }
  }
  const repositoryDataDir = path.resolve(process.cwd(), 'data');
  const relativeToData = path.relative(repositoryDataDir, resolvedSandbox);
  if (relativeToData !== '' && !relativeToData.startsWith('..') && !path.isAbsolute(relativeToData)) {
    throw new Error('G5 沙箱数据库不得位于仓库 data 目录');
  }
  if (resolvedSandbox === repositoryDataDir) {
    throw new Error('G5 沙箱数据库不得位于仓库 data 目录');
  }
}

/**
 * 表可能不存在于源库（G4 sandbox v5 上没有 v6 新增的 strategy_* 表）。
 * 与 G4 沙箱一致：源库缺表按 0 计数，避免误判为不一致。
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

function tableExists(db: SqliteDatabase, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined
  );
}

/**
 * 源库（G4 sandbox v5）必须已包含一份激活中的市场位置版本，
 * 否则 G5 策略窗口没有可用的市场位置输入。此处只读校验，不伪造版本。
 */
function assertSourceHasActiveMarketPosition(db: SqliteDatabase): void {
  const meta = db
    .prepare("SELECT active_version_id FROM market_position_meta WHERE id = 'default'")
    .get() as { active_version_id: string | null } | undefined;
  const activeVersionId = meta?.active_version_id;
  const activeRow = db
    .prepare("SELECT 1 FROM market_position_versions WHERE status = 'active' LIMIT 1")
    .get();
  if (!activeVersionId || activeRow === undefined) {
    throw new Error(
      'G4 沙箱源库没有激活中的市场位置版本，无法准备 G5 沙箱。\n' +
        '恢复步骤：先运行 `npm run g4:sandbox:prepare`（或启动 G4 沙箱），' +
        '在 G4 沙箱中建立并激活一份正式的市场位置版本，再重试 G5 沙箱准备。' +
        '（不会伪造 G4 版本。）',
    );
  }
}

export function prepareG5Sandbox(options: {
  sourceDatabasePath?: string;
  sandboxDatabasePath?: string;
} = {}): G5SandboxPrepareReport {
  const sourceDatabasePath = options.sourceDatabasePath ?? G4_SANDBOX_SOURCE_DB_PATH;
  const sandboxDatabasePath = options.sandboxDatabasePath ?? G5_SANDBOX_DB_PATH;
  const realDatabasePath = getDbPath();

  assertSourceDatabaseExists(sourceDatabasePath);
  assertSandboxPathIsSafe(sandboxDatabasePath, [sourceDatabasePath, realDatabasePath]);

  // 只读打开源库校验 schema 版本与激活中的市场位置版本，校验完立即关闭。
  const sourceDbReadonly = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });
  const sourceSchemaVersion = getDatabaseSchemaVersion(sourceDbReadonly);
  if (sourceSchemaVersion !== EXPECTED_SOURCE_SCHEMA_VERSION) {
    sourceDbReadonly.close();
    throw new Error(
      `G4 沙箱源库 schema 版本不是 ${EXPECTED_SOURCE_SCHEMA_VERSION}：实际 ${sourceSchemaVersion}。\n` +
        '恢复步骤：先运行 `npm run g4:sandbox:prepare` 重新生成 G4 沙箱 v5 源库，' +
        '并在其中建立并激活一份正式的市场位置版本，再重试 G5 沙箱准备。',
    );
  }
  assertSourceHasActiveMarketPosition(sourceDbReadonly);
  const sourceRowCounts = readRowCounts(sourceDbReadonly);
  sourceDbReadonly.close();

  const sourceSha256Before = sha256Hex(fs.readFileSync(sourceDatabasePath));
  const realDbExists = fs.existsSync(realDatabasePath);
  const realDbSha256Before = realDbExists ? sha256Hex(fs.readFileSync(realDatabasePath)) : null;

  fs.mkdirSync(path.dirname(sandboxDatabasePath), { recursive: true });
  fs.rmSync(sandboxDatabasePath, { force: true });
  fs.rmSync(`${sandboxDatabasePath}-wal`, { force: true });
  fs.rmSync(`${sandboxDatabasePath}-shm`, { force: true });

  fs.copyFileSync(sourceDatabasePath, sandboxDatabasePath);

  const sourceSha256After = sha256Hex(fs.readFileSync(sourceDatabasePath));
  const sourceUnchanged = sourceSha256Before === sourceSha256After;
  if (!sourceUnchanged) {
    throw new Error('G5 沙箱准备过程中检测到 G4 源库被修改，已中止');
  }
  const realDbSha256After = realDbExists ? sha256Hex(fs.readFileSync(realDatabasePath)) : null;
  const realDbUnchanged = realDbSha256Before === realDbSha256After;
  if (!realDbUnchanged) {
    throw new Error('G5 沙箱准备过程中检测到真实数据库被修改，已中止');
  }

  const sandboxDb = openDb(sandboxDatabasePath);
  sandboxDb.pragma('journal_mode = DELETE');
  sandboxDb.pragma('foreign_keys = ON');
  const sandboxSchemaVersionBefore = getDatabaseSchemaVersion(sandboxDb);
  initSchema(sandboxDb, { targetVersion: STRATEGY_WINDOW_SCHEMA_VERSION });
  const sandboxSchemaVersionAfter = getDatabaseSchemaVersion(sandboxDb);
  if (sandboxSchemaVersionAfter !== STRATEGY_WINDOW_SCHEMA_VERSION) {
    sandboxDb.close();
    throw new Error(
      `G5 沙箱升级后 schema 版本不是 ${STRATEGY_WINDOW_SCHEMA_VERSION}：实际 ${sandboxSchemaVersionAfter}`,
    );
  }

  const integrityRows = sandboxDb.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  const integrityOk = integrityRows.length === 1 && Object.values(integrityRows[0]!)[0] === 'ok';
  const foreignKeyViolationCount = (sandboxDb.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;

  const sandboxRowCounts = readRowCounts(sandboxDb);

  const newTableRowCounts: Record<string, number> = {};
  let newTablesEmpty = true;
  for (const table of G5_NEW_TABLES) {
    if (!tableExists(sandboxDb, table)) {
      sandboxDb.close();
      throw new Error(`G5 沙箱缺少 G5 新表：${table}`);
    }
    const count = tableRowCountOrZero(sandboxDb, table);
    newTableRowCounts[table] = count;
    if (count !== 0) newTablesEmpty = false;
  }
  sandboxDb.close();

  const rowCounts: G5SandboxPrepareReport['rowCounts'] = {};
  let allRowCountsMatched = true;
  for (const table of ROW_COUNT_TABLES) {
    const source = sourceRowCounts[table] ?? 0;
    const sandbox = sandboxRowCounts[table] ?? 0;
    const matched = source === sandbox;
    if (!matched) allRowCountsMatched = false;
    rowCounts[table] = { source, sandbox, matched };
  }

  if (!integrityOk) {
    throw new Error('G5 沙箱 integrity_check 未通过');
  }
  if (foreignKeyViolationCount > 0) {
    throw new Error(`G5 沙箱 foreign_key_check 发现 ${foreignKeyViolationCount} 处违规`);
  }
  if (!allRowCountsMatched) {
    throw new Error('G5 沙箱 G1~G4 关键表行数与 G4 源库不一致');
  }
  if (!newTablesEmpty) {
    throw new Error('G5 沙箱新表在初始化后不为空');
  }

  return {
    sourceDatabasePath,
    sandboxDatabasePath,
    realDatabasePath,
    sourceSha256Before,
    sourceSha256After,
    sourceUnchanged,
    realDbSha256Before,
    realDbSha256After,
    realDbUnchanged,
    sourceSchemaVersion,
    sandboxSchemaVersionBefore,
    sandboxSchemaVersionAfter,
    integrityOk,
    foreignKeyViolationCount,
    rowCounts,
    allRowCountsMatched,
    newTableRowCounts,
    newTablesEmpty,
  };
}

function main(): void {
  const report = prepareG5Sandbox();
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
