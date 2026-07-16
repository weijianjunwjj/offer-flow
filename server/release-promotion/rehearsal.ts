import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath, openDb, type SqliteDatabase } from '../db';
import { getDatabaseSchemaVersion } from '../migrations';
import { initSchema } from '../schema';
import { sha256Hex } from '../sync/hash';
import { canonicalJson } from '../job-memory/requestHash';
import { exportPromotionBundle, importPromotionBundle, type PromotionBundle } from './bundle';

export const G6_DIR = path.join(process.cwd(), 'tmp', 'g6-rehearsal');
export const G6_CANDIDATE_DB = path.join(G6_DIR, 'offerflow-v6-release-candidate.sqlite3');
export const G6_PRE_UPGRADE_BACKUP = path.join(G6_DIR, 'offerflow-v4-pre-upgrade-backup.sqlite3');
export const G6_ROLLBACK_RESTORED = path.join(G6_DIR, 'offerflow-v4-rollback-restored.sqlite3');
export const G6_PROMOTION_DIR = path.join(G6_DIR, 'promotion');
export const G6_BUNDLE_PATH = path.join(G6_PROMOTION_DIR, 'offerflow-v0.7-g4-g5-promotion.json');
export const G6_ATTESTATION_PATH = path.join(G6_PROMOTION_DIR, 'offerflow-v0.7-g4-g5-promotion.attestation.json');
export const G6_SANDBOX_SOURCE_DB = path.join(process.cwd(), 'tmp', 'g5-sandbox', 'offerflow-v6.sqlite3');

// G1~G3 正式数据关键表：迁移前后（v4 备份 vs v6 候选）内容必须逐字节保持。
const PRESERVED_TABLES = [
  'profiles', 'jobs', 'resume_versions', 'applications', 'feedback_events',
  'capability_baseline_meta', 'candidate_evidence', 'capability_baseline_proposals',
  'capability_baseline_versions', 'capability_command_receipts',
  'historical_import_sessions', 'historical_baseline_drafts',
  'historical_event_drafts', 'historical_import_receipts',
] as const;

const MEMORY_TABLES = ['jobs', 'applications', 'feedback_events'] as const;
const G45_TABLES = [
  'market_position_meta', 'market_position_proposals', 'market_position_versions', 'market_position_receipts',
  'strategy_meta', 'strategy_proposals', 'strategy_versions', 'strategy_receipts',
] as const;

function tableExists(db: SqliteDatabase, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}
function rowCount(db: SqliteDatabase, table: string): number {
  if (!tableExists(db, table)) return 0;
  return Number((db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }).c);
}
function tableContentHash(db: SqliteDatabase, table: string): string {
  if (!tableExists(db, table)) return 'absent';
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  return sha256Hex(Buffer.from(canonicalJson(rows)));
}
function integrityOk(db: SqliteDatabase): boolean {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
  return rows.length === 1 && Object.values(rows[0]!)[0] === 'ok';
}
function fkViolations(db: SqliteDatabase): number {
  return (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
}
function fileStat(p: string): { size: number; mtimeMs: number } {
  const s = fs.statSync(p);
  return { size: s.size, mtimeMs: s.mtimeMs };
}
function rmDb(p: string): void {
  fs.rmSync(p, { force: true });
  fs.rmSync(`${p}-wal`, { force: true });
  fs.rmSync(`${p}-shm`, { force: true });
}

interface RehearsalPaths {
  candidate: string;
  preUpgradeBackup: string;
  rollbackRestored: string;
  promotionDir: string;
  bundle: string;
  attestation: string;
}
function resolvePaths(outputDir: string): RehearsalPaths {
  return {
    candidate: path.join(outputDir, 'offerflow-v6-release-candidate.sqlite3'),
    preUpgradeBackup: path.join(outputDir, 'offerflow-v4-pre-upgrade-backup.sqlite3'),
    rollbackRestored: path.join(outputDir, 'offerflow-v4-rollback-restored.sqlite3'),
    promotionDir: path.join(outputDir, 'promotion'),
    bundle: path.join(outputDir, 'promotion', 'offerflow-v0.7-g4-g5-promotion.json'),
    attestation: path.join(outputDir, 'promotion', 'offerflow-v0.7-g4-g5-promotion.attestation.json'),
  };
}

export interface RehearsalReport {
  realDatabasePath: string;
  realSchemaVersion: number;
  realSha256Before: string;
  realSha256After: string;
  realDbUnchanged: boolean;
  realStat: { size: number; mtimeMs: number };
  realIntegrityOk: boolean;
  realFkViolations: number;
  preservedCounts: Record<string, number>;
  candidatePath: string;
  candidateSha256: string;
  preUpgradeBackupPath: string;
  preUpgradeBackupSha256: string;
  migrationSequence: number[];
  candidateSchemaVersion: number;
  candidateIntegrityOk: boolean;
  candidateFkViolations: number;
  preservedPreserved: boolean;
  g45TablesEmptyAfterMigration: boolean;
  bundleHash: string;
  payloadCanonicalHash: string;
  g4ActiveVersionId: string;
  g5ActiveWindowId: string;
  g5ActiveVersionId: string;
  promotionVerified: boolean;
  memoryCountsUnchanged: boolean;
  reimportAlreadyApplied: boolean;
}

/**
 * 生产迁移演练：只操作真实库的一致性副本，绝不写真实库。
 * v4→v5→v6 迁移 + 已验收 G4/G5 晋升包导入 + 幂等复算，全过程验证真实库 hash 不变。
 */
export function prepareReleaseCandidate(options: { sandboxSourcePath?: string; realDatabasePath?: string; outputDir?: string } = {}): RehearsalReport {
  const realDatabasePath = options.realDatabasePath ?? getDbPath();
  const sandboxSourcePath = options.sandboxSourcePath ?? G6_SANDBOX_SOURCE_DB;
  const outputDir = options.outputDir ?? G6_DIR;
  const P = resolvePaths(outputDir);
  // 本函数内以可参数化的输出目录路径覆盖默认固定路径，便于测试隔离。
  const G6_CANDIDATE_DB = P.candidate;
  const G6_PRE_UPGRADE_BACKUP = P.preUpgradeBackup;
  const G6_PROMOTION_DIR = P.promotionDir;
  const G6_BUNDLE_PATH = P.bundle;
  const G6_ATTESTATION_PATH = P.attestation;

  if (!fs.existsSync(realDatabasePath)) throw new Error(`真实数据库不存在：${realDatabasePath}`);
  if (!fs.existsSync(sandboxSourcePath)) {
    throw new Error(`G4/G5 晋升来源不存在：${sandboxSourcePath}\n恢复步骤：先运行 npm run g5:sandbox:prepare 并在 G5 沙箱完成验收激活。`);
  }

  // 2. 真实库只读基线。
  const realSha256Before = sha256Hex(fs.readFileSync(realDatabasePath));
  const realStat = fileStat(realDatabasePath);
  const realRo = new Database(realDatabasePath, { readonly: true, fileMustExist: true });
  const realSchemaVersion = getDatabaseSchemaVersion(realRo);
  const realIntegrityOk = integrityOk(realRo);
  const realFkViolations = fkViolations(realRo);
  const preservedCounts: Record<string, number> = {};
  const preservedHashesReal: Record<string, string> = {};
  for (const t of PRESERVED_TABLES) { preservedCounts[t] = rowCount(realRo, t); preservedHashesReal[t] = tableContentHash(realRo, t); }
  const memoryCountsBefore: Record<string, number> = {};
  for (const t of MEMORY_TABLES) memoryCountsBefore[t] = rowCount(realRo, t);
  realRo.close();
  if (realSchemaVersion !== 4) throw new Error(`预期真实库为 schema v4，实际 v${realSchemaVersion}`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(G6_PROMOTION_DIR, { recursive: true });

  // 3. 一致性复制真实 v4 → 候选。
  rmDb(G6_CANDIDATE_DB);
  fs.copyFileSync(realDatabasePath, G6_CANDIDATE_DB);
  // 4. 升级前候选备份（仍为 v4）。
  rmDb(G6_PRE_UPGRADE_BACKUP);
  fs.copyFileSync(G6_CANDIDATE_DB, G6_PRE_UPGRADE_BACKUP);
  const preUpgradeBackupSha256 = sha256Hex(fs.readFileSync(G6_PRE_UPGRADE_BACKUP));

  // 5. 仅对候选副本执行 v4→v5→v6。
  const candidateDb = openDb(G6_CANDIDATE_DB);
  const migrationSequence: number[] = [];
  const r5 = initSchema(candidateDb, { targetVersion: 5 });
  migrationSequence.push(...r5.newlyAppliedVersions);
  const r6 = initSchema(candidateDb, { targetVersion: 6 });
  migrationSequence.push(...r6.newlyAppliedVersions);
  const candidateSchemaVersion = getDatabaseSchemaVersion(candidateDb);
  if (candidateSchemaVersion !== 6) { candidateDb.close(); throw new Error(`候选库升级后应为 v6，实际 v${candidateSchemaVersion}`); }
  const candidateIntegrityOk = integrityOk(candidateDb);
  const candidateFkViolations = fkViolations(candidateDb);

  // 9. G1~G3 关键表内容保持。
  let preservedPreserved = true;
  for (const t of PRESERVED_TABLES) {
    if (rowCount(candidateDb, t) !== preservedCounts[t] || tableContentHash(candidateDb, t) !== preservedHashesReal[t]) preservedPreserved = false;
  }
  // 10. G4/G5 新表迁移后为空。
  let g45TablesEmptyAfterMigration = true;
  for (const t of G45_TABLES) { if (rowCount(candidateDb, t) !== 0) g45TablesEmptyAfterMigration = false; }
  candidateDb.close();

  if (!candidateIntegrityOk) throw new Error('候选库 integrity_check 未通过');
  if (candidateFkViolations > 0) throw new Error(`候选库 foreign_key_check 违规 ${candidateFkViolations}`);
  if (!preservedPreserved) throw new Error('候选库 G1~G3 关键表在迁移后发生变化');
  if (!g45TablesEmptyAfterMigration) throw new Error('候选库 G4/G5 新表迁移后不为空');

  // 11. 从沙箱来源只读导出晋升包。
  const sandboxSha = sha256Hex(fs.readFileSync(sandboxSourcePath));
  const sandboxRo = new Database(sandboxSourcePath, { readonly: true, fileMustExist: true });
  const { bundle, attestation } = exportPromotionBundle(sandboxRo, { sourceDatabasePath: sandboxSourcePath, sourceDatabaseHash: sandboxSha });
  sandboxRo.close();
  const sandboxShaAfter = sha256Hex(fs.readFileSync(sandboxSourcePath));
  if (sandboxSha !== sandboxShaAfter) throw new Error('导出晋升包过程中来源沙箱库被修改');
  fs.writeFileSync(G6_BUNDLE_PATH, JSON.stringify(bundle, null, 2));
  fs.writeFileSync(G6_ATTESTATION_PATH, JSON.stringify(attestation, null, 2));

  // 12. 事务性导入候选库。
  const candidateWrite = openDb(G6_CANDIDATE_DB);
  const importResult = importPromotionBundle(candidateWrite, bundle, attestation);
  // 13. 导入后验证。
  const { promotionVerified } = verifyPromotion(candidateWrite, bundle);
  // 14. 记忆表行数不变。
  let memoryCountsUnchanged = true;
  for (const t of MEMORY_TABLES) { if (rowCount(candidateWrite, t) !== memoryCountsBefore[t]) memoryCountsUnchanged = false; }
  candidateWrite.close();

  // 15. 相同 bundle 再次导入 → alreadyApplied，不重复写入。
  const candidateReimport = openDb(G6_CANDIDATE_DB);
  const reimport = importPromotionBundle(candidateReimport, bundle, attestation);
  candidateReimport.close();

  if (!importResult.applied) throw new Error('晋升包首次导入未写入');
  if (!promotionVerified) throw new Error('晋升导入后校验失败');
  if (!memoryCountsUnchanged) throw new Error('晋升导入改变了 Job/Application/FeedbackEvent 行数');
  if (!reimport.alreadyApplied) throw new Error('相同晋升包重复导入未返回 alreadyApplied');

  // 16/17. 候选与真实库 hash。
  const candidateSha256 = sha256Hex(fs.readFileSync(G6_CANDIDATE_DB));
  const realSha256After = sha256Hex(fs.readFileSync(realDatabasePath));
  const realDbUnchanged = realSha256Before === realSha256After;
  if (!realDbUnchanged) throw new Error('演练过程中检测到真实数据库被修改，已中止');

  return {
    realDatabasePath, realSchemaVersion, realSha256Before, realSha256After, realDbUnchanged, realStat,
    realIntegrityOk, realFkViolations, preservedCounts,
    candidatePath: G6_CANDIDATE_DB, candidateSha256,
    preUpgradeBackupPath: G6_PRE_UPGRADE_BACKUP, preUpgradeBackupSha256,
    migrationSequence, candidateSchemaVersion, candidateIntegrityOk, candidateFkViolations,
    preservedPreserved, g45TablesEmptyAfterMigration,
    bundleHash: attestation.bundleHash, payloadCanonicalHash: attestation.payloadCanonicalHash,
    g4ActiveVersionId: attestation.g4ActiveVersionId, g5ActiveWindowId: attestation.g5ActiveWindowId,
    g5ActiveVersionId: attestation.g5ActiveVersionId,
    promotionVerified, memoryCountsUnchanged, reimportAlreadyApplied: reimport.alreadyApplied,
  };
}

export function verifyPromotion(db: SqliteDatabase, bundle: PromotionBundle): { promotionVerified: boolean } {
  const mpMeta = db.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as { active_version_id: string } | undefined;
  const swMeta = db.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as { active_version_id: string } | undefined;
  if (mpMeta?.active_version_id !== bundle.marketPosition.activeVersionId) return { promotionVerified: false };
  if (swMeta?.active_version_id !== bundle.strategy.activeVersionId) return { promotionVerified: false };
  const swRow = db.prepare('SELECT data_json FROM strategy_versions WHERE id=?').get(bundle.strategy.activeVersionId) as { data_json: string } | undefined;
  if (swRow === undefined) return { promotionVerified: false };
  const sw = JSON.parse(swRow.data_json) as Record<string, unknown>;
  const window = sw.window as Record<string, unknown>;
  const sourceIds = window.sourceVersionIds as Record<string, unknown>;
  const generationModeOk = sw.generationMode === (bundle.strategy.version as Record<string, unknown>).generationMode;
  const decisionDiffOk = Array.isArray(sw.decisionDiff);
  const g4RefOk = sourceIds.marketPositionVersionId === mpMeta?.active_version_id;
  return { promotionVerified: generationModeOk && decisionDiffOk && g4RefOk };
}

export interface RollbackReport {
  preUpgradeBackupPath: string;
  preUpgradeBackupSha256: string;
  restoredPath: string;
  restoredSha256: string;
  restoredSchemaVersion: number;
  restoredIntegrityOk: boolean;
  restoredFkViolations: number;
  hashMatchesBackup: boolean;
  hashMatchesRealBaseline: boolean;
  preservedCountsMatch: boolean;
}

/**
 * 回滚演练：在一次性副本上实际验证——模拟发布失败后，用升级前 v4 备份恢复，
 * 证明恢复文件为 schema v4、hash 与升级前完全一致、G1~G3 行数不变。绝不做 v6 逆向 migration。
 */
export function rehearseRollback(options: { realDatabasePath?: string; outputDir?: string } = {}): RollbackReport {
  const realDatabasePath = options.realDatabasePath ?? getDbPath();
  const P = resolvePaths(options.outputDir ?? G6_DIR);
  const G6_PRE_UPGRADE_BACKUP = P.preUpgradeBackup;
  const G6_ROLLBACK_RESTORED = P.rollbackRestored;
  if (!fs.existsSync(G6_PRE_UPGRADE_BACKUP)) throw new Error('缺少升级前 v4 备份，请先运行 g6:rehearsal:prepare');

  const preUpgradeBackupSha256 = sha256Hex(fs.readFileSync(G6_PRE_UPGRADE_BACKUP));
  // 5. 使用升级前备份恢复到另一个 rollback 文件。
  rmDb(G6_ROLLBACK_RESTORED);
  fs.copyFileSync(G6_PRE_UPGRADE_BACKUP, G6_ROLLBACK_RESTORED);
  const restoredSha256 = sha256Hex(fs.readFileSync(G6_ROLLBACK_RESTORED));

  const restoredRo = new Database(G6_ROLLBACK_RESTORED, { readonly: true, fileMustExist: true });
  const restoredSchemaVersion = getDatabaseSchemaVersion(restoredRo);
  const restoredIntegrityOk = integrityOk(restoredRo);
  const restoredFkViolations = fkViolations(restoredRo);
  const restoredCounts: Record<string, number> = {};
  for (const t of PRESERVED_TABLES) restoredCounts[t] = rowCount(restoredRo, t);
  restoredRo.close();

  const realRo = new Database(realDatabasePath, { readonly: true, fileMustExist: true });
  const realSha = sha256Hex(fs.readFileSync(realDatabasePath));
  let preservedCountsMatch = true;
  for (const t of PRESERVED_TABLES) { if (rowCount(realRo, t) !== restoredCounts[t]) preservedCountsMatch = false; }
  realRo.close();

  const hashMatchesBackup = restoredSha256 === preUpgradeBackupSha256;
  const hashMatchesRealBaseline = restoredSha256 === realSha;

  if (restoredSchemaVersion !== 4) throw new Error(`回滚恢复文件应为 schema v4，实际 v${restoredSchemaVersion}`);
  if (!restoredIntegrityOk) throw new Error('回滚恢复文件 integrity_check 未通过');
  if (restoredFkViolations > 0) throw new Error('回滚恢复文件存在外键违规');
  if (!hashMatchesBackup) throw new Error('回滚恢复文件与升级前备份 hash 不一致');
  if (!preservedCountsMatch) throw new Error('回滚恢复文件 G1~G3 行数与真实库不一致');

  return {
    preUpgradeBackupPath: G6_PRE_UPGRADE_BACKUP, preUpgradeBackupSha256,
    restoredPath: G6_ROLLBACK_RESTORED, restoredSha256, restoredSchemaVersion,
    restoredIntegrityOk, restoredFkViolations, hashMatchesBackup, hashMatchesRealBaseline, preservedCountsMatch,
  };
}
