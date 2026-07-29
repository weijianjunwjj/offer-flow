import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 轻量运行时契约：Playwright worker 只读此文件，不加载 Vite/Fastify。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-action-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/**
 * 动作基线：正式对象计数 + 四表行签名。
 *
 * 与推荐沙箱不同，这里 seed 阶段**故意晋升一个候选**（写入 1 份 Job/Application/
 * FeedbackEvent/Promotion），基线在晋升后拍摄。之后任何动作（收藏/忽略/标记优先/
 * 已投待反馈及其撤销）都不得改动这些正式对象——签名可检出原地 UPDATE 与行删除。
 */
export interface ActionE2EBaseline {
  jobs: number;
  applications: number;
  feedbackEvents: number;
  promotions: number;
  /** 四张正式表按 id 排序的联合签名。动作与撤销后必须逐字节不变。 */
  formalSig: string;
}

export interface ActionE2ERuntime {
  /** flag：radar + recommendations 开启（动作栏随评审工作台渲染；推荐面板验证失效联动）。 */
  webUrl: string;
  /** v8 后端直连 URL：worker 用于命中真实动作/推荐 API 与只读断言。 */
  apiUrl: string;
  dbPath: string;
  /** 疑似重复关系（scope=2，两侧均 seed current 分析）：UI 打开后每侧一个动作栏、可生成 2 条建议。 */
  suspectedRelationId: string;
  /** 疑似关系两侧候选 id（动作 API 按 candidateId 寻址；供 UI 动作的库内校验）。 */
  suspectedLowCandidateId: string;
  suspectedHighCandidateId: string;
  /** 疑似关系两侧当前正式版本 id（推荐 scope）。 */
  suspectedScope: string[];
  /** 已晋升候选 id：验证对其执行/撤销动作后正式 Job/Application/FeedbackEvent/Promotion 不变。 */
  promotedCandidateId: string;
  /** 独立 API 候选 id（历史 append-only / 幂等 / no_response 各取一个）。 */
  apiCandidateIds: string[];
  baseline: ActionE2EBaseline;
}

/** 最小 SQL 句柄形状：harness（openDb）与 spec（better-sqlite3 只读）通用。 */
export interface SqlLike { prepare(sql: string): { all(): unknown[] } }

/** 全表按 id 排序的确定性签名，用于检出任意列的原地 UPDATE 或行删除。 */
export function tableSignature(db: SqlLike, table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** 四张正式表的联合签名（Job/Application/FeedbackEvent/Promotion）。 */
export function formalSignature(db: SqlLike): string {
  const parts = ['jobs', 'applications', 'feedback_events', 'radar_promotions']
    .map((t) => `${t}:${tableSignature(db, t)}`);
  return createHash('sha256').update(parts.join('|')).digest('hex');
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

export function readRuntime(): ActionE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as ActionE2ERuntime;
}
