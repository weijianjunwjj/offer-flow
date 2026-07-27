import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 轻量运行时契约：Playwright worker 只读此文件，不加载 Vite/Fastify。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-recommendation-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/** 零污染基线：数量 + 行签名（后者可检出原地 UPDATE / 删除，仅数量无法发现）。 */
export interface RecommendationE2EBaseline {
  jobs: number;
  applications: number;
  feedbackEvents: number;
  candidateVersionsSig: string;
  ruleAssessmentsSig: string;
  analysisRecordsSig: string;
}

export interface RecommendationE2ERuntime {
  /** flag：radar + recommendations 开启，analysis 关闭（证明推荐面板独立于 V8-4 前端门禁）。 */
  webUrl: string;
  /** v8 后端直连 URL：worker 用于命中真实推荐 API（生成 wide 批次）与只读断言。 */
  apiUrl: string;
  dbPath: string;
  /** 疑似重复关系（scope=2，两侧均 seed current 分析）：UI 生成 → 展示 2 条。 */
  suspectedRelationId: string;
  /** needs_recheck 关系（scope=2，两侧均无分析）：切换清理 + 0 条 emptyReason。 */
  recheckRelationId: string;
  /** wide scope：8 条可推荐 + 2 条硬约束命中；供 API 直建批次后「加载最新」展示 1–8 + blocked。 */
  wideScope: string[];
  baseline: RecommendationE2EBaseline;
}

/** 最小 SQL 句柄形状：harness（openDb）与 spec（better-sqlite3 只读）通用。 */
export interface SqlLike { prepare(sql: string): { all(): unknown[] } }

/** 全表按 id 排序的确定性签名，用于检出任意列的原地 UPDATE 或行删除。 */
export function tableSignature(db: SqlLike, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export interface PragmaLike { pragma(sql: string): unknown }

/** integrity_check：无损坏时 better-sqlite3 返回单行 { integrity_check: 'ok' }。 */
export function integrityOk(db: PragmaLike): boolean {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

/** foreign_key_check 违规行数：0 表示无悬挂外键。 */
export function foreignKeyViolations(db: PragmaLike): number {
  return (db.pragma('foreign_key_check') as unknown[]).length;
}

export function readRuntime(): RecommendationE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RecommendationE2ERuntime;
}
