import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewFixtureResult } from '../server/radar/reviewFixture';

/** 轻量运行时契约：Playwright worker 只读此文件，不加载 Vite/Fastify（类型导入会被擦除）。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-analysis-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/** 零污染基线：数量 + 行签名（后者可检出原地 UPDATE / 删除，仅数量无法发现）。 */
export interface AnalysisE2EBaseline {
  jobs: number;
  applications: number;
  feedbackEvents: number;
  candidateVersionsSig: string;
  ruleAssessmentsSig: string;
}

export interface AnalysisE2ERuntime {
  /** flag 全开（radar + analysis）的前端，代理到 v8 后端。 */
  webUrl: string;
  /** v8 后端直连 URL：worker 用于命中 E2E 控制端点（释放闸门）与只读断言以外的直调。 */
  apiUrl: string;
  dbPath: string;
  fixture: ReviewFixtureResult;
  /** material_change 候选当前正式版本 id（分析目标）。 */
  materialCandidateVersionId: string;
  baseline: AnalysisE2EBaseline;
}

/** 最小 SQL 句柄形状：harness（openDb）与 spec（better-sqlite3 只读）通用。 */
export interface SqlLike { prepare(sql: string): { all(): unknown[] } }

/** 全表按 id 排序的确定性签名，用于检出任意列的原地 UPDATE 或行删除。 */
export function tableSignature(db: SqlLike, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** 最小 pragma 句柄：better-sqlite3 只读连接即可执行完整性/外键自检。 */
export interface PragmaLike { pragma(sql: string): unknown }

/** integrity_check 结果：无损坏时 better-sqlite3 返回单行 { integrity_check: 'ok' }。 */
export function integrityOk(db: PragmaLike): boolean {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

/** foreign_key_check 违规行数：0 表示无悬挂外键。 */
export function foreignKeyViolations(db: PragmaLike): number {
  return (db.pragma('foreign_key_check') as unknown[]).length;
}

export function readRuntime(): AnalysisE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as AnalysisE2ERuntime;
}
