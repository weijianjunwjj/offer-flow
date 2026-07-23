import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReviewFixtureResult } from '../server/radar/reviewFixture';

/** 轻量运行时契约：测试 worker 只读此文件，避免加载 Vite/Fastify（类型导入会被擦除）。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-review-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/** 安全不变量基线：数量 + 行签名（后者可检出 UPDATE，仅数量无法发现原地修改）。 */
export interface ReviewE2EBaseline {
  jobs: number;
  applications: number;
  feedbackEvents: number;
  candidates: number;
  candidateVersions: number;
  ruleAssessments: number;
  /** radar_candidate_versions 全表按 id 排序后的 sha256，用于断言 CandidateVersion 未被修改。 */
  candidateVersionsSig: string;
  /** radar_rule_assessments 全表按 id 排序后的 sha256，用于断言 RuleAssessment 未被 UPDATE/删除。 */
  ruleAssessmentsSig: string;
}

export interface ReviewE2ERuntime {
  webOnUrl: string;
  webOffUrl: string;
  apiV7Url: string;
  dbPath: string;
  fixture: ReviewFixtureResult;
  baseline: ReviewE2EBaseline;
}

/** 最小 SQL 句柄形状：harness（openDb）与 spec（better-sqlite3 只读）通用。 */
export interface SqlLike { prepare(sql: string): { all(): unknown[] } }

/** 全表按 id 排序的确定性签名，用于检出任意列的原地 UPDATE 或行删除。 */
export function tableSignature(db: SqlLike, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function readRuntime(): ReviewE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as ReviewE2ERuntime;
}
