/**
 * G6-B 真实生产切换操作脚本（逐步、可中止、可回滚）。
 *
 * 子命令：
 *   backup       创建并验证升级前 schema v4 一致性备份 + 一次性回滚验证（需 --confirm）
 *   promote      将 G6-A 已验证晋升包事务性导入真实 schema v6 库 + 幂等复算（需 --confirm）
 *   verify       真实库只读证明（schema/完整性/G1~G5 可读/writes=0）
 *   post-backup  切换后创建并验证 schema v6 一致性备份（需 --confirm）
 *
 * 迁移 v4→v6 使用既有显式工具 `npm run db:upgrade-real`，不在本脚本内实现。
 * 本脚本不发布 Snapshot、不调用 AI、不写 Job/Application/FeedbackEvent。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath, openDb, type SqliteDatabase } from '../server/db';
import { getDatabaseSchemaVersion } from '../server/migrations';
import { sha256Hex } from '../server/sync/hash';
import { canonicalJson } from '../server/job-memory/requestHash';
import { importPromotionBundle, PromotionError, type PromotionAttestation, type PromotionBundle } from '../server/release-promotion/bundle';

const REAL = getDbPath();
const CUTOVER_DIR = path.join(process.cwd(), 'backups', 'v0.7-production-cutover');
const BUNDLE_PATH = path.join(process.cwd(), 'tmp', 'g6-rehearsal', 'promotion', 'offerflow-v0.7-g4-g5-promotion.json');
const ATT_PATH = path.join(process.cwd(), 'tmp', 'g6-rehearsal', 'promotion', 'offerflow-v0.7-g4-g5-promotion.attestation.json');

const EXPECTED_BASELINE_SHA = 'cdc214c8d9601ce2a5e084c953387ea8bc576abdf4b53f993835b59a22974af3';
const AUTH = {
  payloadPrefix: '34e8c4d5',
  g4: 'BCO_OHOKj4z4SZ7fkBaTC',
  g5win: 'sw-069343080027d893',
  g5ver: 'WBvQlz3yIigQ4o2bPv8Wj',
};

const PRESERVED = [
  'profiles', 'jobs', 'resume_versions', 'applications', 'feedback_events',
  'candidate_evidence', 'capability_baseline_proposals', 'capability_baseline_versions',
  'capability_command_receipts', 'capability_baseline_meta',
  'historical_import_sessions', 'historical_baseline_drafts', 'historical_event_drafts', 'historical_import_receipts',
] as const;
const MEMORY = ['jobs', 'applications', 'feedback_events'] as const;

function hasFlag(n: string): boolean { return process.argv.includes(`--${n}`); }
function stamp(): string { return new Date().toISOString().replace(/[:.]/g, '-'); }
function tableExists(db: SqliteDatabase, t: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(t) !== undefined;
}
function count(db: SqliteDatabase, t: string): number {
  return tableExists(db, t) ? Number((db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as any).c) : -1;
}
function counts(db: SqliteDatabase): Record<string, number> {
  const o: Record<string, number> = {};
  for (const t of PRESERVED) o[t] = count(db, t);
  return o;
}
function contentHash(db: SqliteDatabase, t: string): string {
  if (!tableExists(db, t)) return 'absent';
  return sha256Hex(Buffer.from(canonicalJson(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all())));
}
function businessHash(db: SqliteDatabase): string {
  return sha256Hex(Buffer.from(canonicalJson(PRESERVED.map((t) => [t, contentHash(db, t)]))));
}
function integrityOk(db: SqliteDatabase): boolean {
  const r = db.prepare('PRAGMA integrity_check').all() as any[];
  return r.length === 1 && Object.values(r[0])[0] === 'ok';
}
function fkV(db: SqliteDatabase): number { return (db.prepare('PRAGMA foreign_key_check').all() as any[]).length; }
function die(msg: string): never { console.error(`[G6-B] 中止：${msg}`); process.exit(1); }

function readonlyDb(p: string): SqliteDatabase { return new Database(p, { readonly: true, fileMustExist: true }); }

function loadBundle(): { bundle: PromotionBundle; attestation: PromotionAttestation } {
  if (!fs.existsSync(BUNDLE_PATH) || !fs.existsSync(ATT_PATH)) die('晋升包或 attestation 不存在');
  return {
    bundle: JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8')) as PromotionBundle,
    attestation: JSON.parse(fs.readFileSync(ATT_PATH, 'utf8')) as PromotionAttestation,
  };
}

function assertSemanticGate(bundle: PromotionBundle): void {
  if (!bundle.payloadCanonicalHash.startsWith(AUTH.payloadPrefix)) die(`payloadCanonicalHash 不匹配授权内容 ${AUTH.payloadPrefix}`);
  if (bundle.marketPosition.activeVersionId !== AUTH.g4) die('G4 active version id 不匹配授权值');
  if (bundle.strategy.activeWindowId !== AUTH.g5win) die('G5 window id 不匹配授权值');
  if (bundle.strategy.activeVersionId !== AUTH.g5ver) die('G5 version id 不匹配授权值');
  const src = bundle.sourceDatabasePath;
  if (!fs.existsSync(src)) die(`晋升来源库不存在：${src}`);
  if (sha256Hex(fs.readFileSync(src)) !== bundle.sourceDatabaseHash) die('晋升来源库 hash 与 bundle 记录不一致');
}

function cmdBackup(): void {
  fs.mkdirSync(CUTOVER_DIR, { recursive: true });
  const ro = readonlyDb(REAL);
  const schema = getDatabaseSchemaVersion(ro);
  const sourceSha = sha256Hex(fs.readFileSync(REAL));
  const baseCounts = counts(ro);
  const iok = integrityOk(ro); const fk = fkV(ro);
  const migrations = ro.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  ro.close();

  if (schema !== 4) die(`真实库 schema 应为 4，实际 ${schema}`);
  if (sourceSha !== EXPECTED_BASELINE_SHA) die(`真实库 hash 与授权基线不一致：${sourceSha}`);
  if (!iok) die('真实库 integrity_check 未通过'); if (fk > 0) die('真实库存在外键违规');
  if (!hasFlag('confirm')) { console.log(JSON.stringify({ action: 'dry-run', schema, sourceSha, baseCounts })); return; }

  const backupPath = path.join(CUTOVER_DIR, `offerflow-schema-v4-pre-cutover-${stamp()}.sqlite3`);
  if (fs.existsSync(backupPath)) die('备份文件已存在，拒绝覆盖');
  fs.copyFileSync(REAL, backupPath);
  const backupSha = sha256Hex(fs.readFileSync(backupPath));
  if (backupSha !== sourceSha) die('备份 hash 与源库不一致');

  const bro = readonlyDb(backupPath);
  const bSchema = getDatabaseSchemaVersion(bro); const bIok = integrityOk(bro); const bFk = fkV(bro);
  const bCounts = counts(bro);
  const bMig = bro.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  bro.close();
  if (bSchema !== 4 || !bIok || bFk > 0) die('备份只读校验失败');
  if (canonicalJson(bCounts) !== canonicalJson(baseCounts)) die('备份行数与源库不一致');
  if (canonicalJson(bMig) !== canonicalJson(migrations)) die('备份迁移记录与源库不一致');

  // 一次性回滚验证：从备份恢复出 rollback-check，证明可精确恢复出相同 hash 的 v4 文件。
  const rollbackCheck = path.join(CUTOVER_DIR, `offerflow-schema-v4-rollback-check-${stamp()}.sqlite3`);
  fs.copyFileSync(backupPath, rollbackCheck);
  const rcSha = sha256Hex(fs.readFileSync(rollbackCheck));
  const rcro = readonlyDb(rollbackCheck);
  const rcOk = getDatabaseSchemaVersion(rcro) === 4 && integrityOk(rcro) && fkV(rcro) === 0;
  rcro.close();
  fs.rmSync(rollbackCheck, { force: true });
  if (rcSha !== backupSha || !rcOk) die('一次性回滚验证失败');

  const report = {
    action: 'pre-cutover-backup', createdAt: new Date().toISOString(),
    realDatabasePath: path.resolve(REAL), schema, sourceSha, backupPath: path.resolve(backupPath), backupSha,
    integrityOk: iok, foreignKeyViolations: fk, migrations, counts: baseCounts,
    rollbackCheck: { restoredSha: rcSha, schemaOk: true, matchesBackup: rcSha === backupSha },
    hashesEqual: sourceSha === backupSha && backupSha === rcSha,
  };
  const reportPath = backupPath.replace(/\.sqlite3$/, '.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[G6-B] 备份验证报告：${reportPath}`);
}

function cmdPromote(): void {
  const { bundle, attestation } = loadBundle();
  assertSemanticGate(bundle);
  if (!hasFlag('confirm')) { console.log(JSON.stringify({ action: 'dry-run-promote', g4: bundle.marketPosition.activeVersionId, g5: bundle.strategy.activeVersionId })); return; }

  // 导入前只读前置检查。
  const pre = readonlyDb(REAL);
  if (getDatabaseSchemaVersion(pre) !== 6) { pre.close(); die('真实库 schema 不是 6，先执行 v4→v6 升级'); }
  const mpActive = pre.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as any;
  const swActive = pre.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as any;
  if (mpActive?.active_version_id) { pre.close(); die('market_position 已存在 active 版本'); }
  if (swActive?.active_version_id) { pre.close(); die('strategy 已存在 active 版本'); }
  const memBefore: Record<string, number> = {}; for (const t of MEMORY) memBefore[t] = count(pre, t);
  const bizBefore = businessHash(pre);
  // accepted evidence 存在性。
  const swSnapshot = (bundle.strategy.version as any).inputSnapshot as { acceptedEvidenceIds?: string[] } | undefined;
  const evidenceIds: string[] = swSnapshot?.acceptedEvidenceIds ?? [];
  if (evidenceIds.length > 0) {
    const acc = new Set((pre.prepare("SELECT id FROM candidate_evidence WHERE status IN ('accepted','modified_and_accepted')").all() as any[]).map((r) => r.id));
    const bad = evidenceIds.find((id) => !acc.has(id));
    if (bad) { pre.close(); die(`accepted evidence 缺失：${bad}`); }
  }
  pre.close();

  // 事务导入。
  const db = openDb(REAL);
  let result;
  try {
    result = importPromotionBundle(db, bundle, attestation);
  } catch (e) {
    db.close();
    if (e instanceof PromotionError) die(`导入失败(${e.code})：${e.message}`);
    throw e;
  }
  // 导入后验证（同一句柄）。
  const mp = db.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as any;
  const sw = db.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as any;
  const swRow = db.prepare('SELECT data_json FROM strategy_versions WHERE id=?').get(bundle.strategy.activeVersionId) as any;
  const swVer = JSON.parse(swRow.data_json);
  const memAfter: Record<string, number> = {}; for (const t of MEMORY) memAfter[t] = count(db, t);
  const bizAfter = businessHash(db);
  db.close();

  const ok = mp?.active_version_id === AUTH.g4 && sw?.active_version_id === AUTH.g5ver
    && swVer.window.sourceVersionIds.marketPositionVersionId === AUTH.g4
    && swVer.generationMode === 'ai' && Array.isArray(swVer.decisionDiff)
    && canonicalJson(memBefore) === canonicalJson(memAfter) && bizBefore === bizAfter;
  if (!result.applied) die('首次导入未写入');
  if (!ok) die('导入后验证失败');

  // 幂等：再次导入必须 alreadyApplied，业务 hash 不变。
  const db2 = openDb(REAL);
  const again = importPromotionBundle(db2, bundle, attestation);
  const bizAgain = businessHash(db2);
  db2.close();
  if (!again.alreadyApplied) die('重复导入未返回 alreadyApplied');
  if (bizAgain !== bizAfter) die('重复导入改变了业务 hash');

  console.log(JSON.stringify({
    action: 'promoted', applied: result.applied, alreadyAppliedOnReimport: again.alreadyApplied,
    g4Active: mp?.active_version_id, g5Active: sw?.active_version_id,
    swRefG4: swVer.window.sourceVersionIds.marketPositionVersionId, generationMode: swVer.generationMode,
    decisionDiffLen: swVer.decisionDiff.length, memBefore, memAfter,
    businessHashUnchanged: bizBefore === bizAfter && bizAfter === bizAgain,
  }, null, 2));
}

function cmdVerify(): void {
  const shaBefore = sha256Hex(fs.readFileSync(REAL));
  const db = readonlyDb(REAL);
  const schema = getDatabaseSchemaVersion(db);
  const iok = integrityOk(db); const fk = fkV(db);
  const profile = db.prepare("SELECT data_json FROM profiles LIMIT 1").get() as any;
  const g1 = profile ? JSON.parse(profile.data_json)?.jobMatchProfile?.activeVersionId ?? null : null;
  const cbActive = (db.prepare("SELECT active_version_id FROM capability_baseline_meta WHERE id='default'").get() as any)?.active_version_id ?? null;
  const funnelCount = count(db, 'applications');
  const mp = (db.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as any)?.active_version_id ?? null;
  const sw = (db.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as any)?.active_version_id ?? null;
  const swRow = sw ? JSON.parse((db.prepare('SELECT data_json FROM strategy_versions WHERE id=?').get(sw) as any).data_json) : null;
  const mem: Record<string, number> = {}; for (const t of MEMORY) mem[t] = count(db, t);
  db.close();
  const shaAfter = sha256Hex(fs.readFileSync(REAL));
  const report = {
    action: 'readonly-verify', schema, integrityOk: iok, foreignKeyViolations: fk,
    g1ActiveJobMatch: g1, g2ActiveBaseline: cbActive, g3ApplicationCount: funnelCount,
    g4Active: mp, g5Active: sw, g5WindowType: swRow?.window?.windowType ?? null,
    g5RefG4: swRow?.window?.sourceVersionIds?.marketPositionVersionId ?? null,
    memory: mem, verifierBusinessWrites: 0, dbHashUnchanged: shaBefore === shaAfter, dbHash: shaAfter,
  };
  console.log(JSON.stringify(report, null, 2));
  if (schema !== 6 || !iok || fk > 0 || mp !== AUTH.g4 || sw !== AUTH.g5ver || shaBefore !== shaAfter) die('只读证明失败');
}

function cmdPostBackup(): void {
  fs.mkdirSync(CUTOVER_DIR, { recursive: true });
  const ro = readonlyDb(REAL);
  const schema = getDatabaseSchemaVersion(ro);
  const sourceSha = sha256Hex(fs.readFileSync(REAL));
  const c = counts(ro); const iok = integrityOk(ro); const fk = fkV(ro);
  const mp = (ro.prepare("SELECT active_version_id FROM market_position_meta WHERE id='default'").get() as any)?.active_version_id ?? null;
  const sw = (ro.prepare("SELECT active_version_id FROM strategy_meta WHERE id='default'").get() as any)?.active_version_id ?? null;
  ro.close();
  if (schema !== 6) die(`切换后真实库应为 schema 6，实际 ${schema}`);
  if (!iok || fk > 0) die('切换后真实库完整性/外键校验失败');
  if (mp !== AUTH.g4 || sw !== AUTH.g5ver) die('切换后真实库缺少预期 active G4/G5 版本');
  if (!hasFlag('confirm')) { console.log(JSON.stringify({ action: 'dry-run-post-backup', schema, sourceSha })); return; }

  const backupPath = path.join(CUTOVER_DIR, `offerflow-schema-v6-post-cutover-${stamp()}.sqlite3`);
  if (fs.existsSync(backupPath)) die('备份文件已存在，拒绝覆盖');
  fs.copyFileSync(REAL, backupPath);
  const backupSha = sha256Hex(fs.readFileSync(backupPath));
  if (backupSha !== sourceSha) die('post 备份 hash 与源库不一致');
  const bro = readonlyDb(backupPath);
  const bOk = getDatabaseSchemaVersion(bro) === 6 && integrityOk(bro) && fkV(bro) === 0;
  const bCounts = counts(bro);
  bro.close();
  if (!bOk) die('post 备份只读校验失败');
  if (canonicalJson(bCounts) !== canonicalJson(c)) die('post 备份行数与源库不一致');
  const report = {
    action: 'post-cutover-backup', createdAt: new Date().toISOString(),
    backupPath: path.resolve(backupPath), backupSha, schema: 6, integrityOk: bOk,
    g4Active: mp, g5Active: sw, counts: c, hashMatchesReal: backupSha === sourceSha,
  };
  fs.writeFileSync(backupPath.replace(/\.sqlite3$/, '.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

function main(): void {
  const cmd = process.argv[2];
  if (cmd === 'backup') return cmdBackup();
  if (cmd === 'promote') return cmdPromote();
  if (cmd === 'verify') return cmdVerify();
  if (cmd === 'post-backup') return cmdPostBackup();
  console.error('用法：tsx scripts/g6ProductionCutover.ts <backup|promote|verify|post-backup> [--confirm]');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
