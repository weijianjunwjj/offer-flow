/**
 * 一次性运维脚本：对指定的 failed 单岗位分析任务执行「人工重新分析 + 运行」。
 *
 * 严格边界：
 * - 只写 analysis_tasks / job_match_analysis_records（V8-4 授权范围内）；
 * - 断言 jobs / applications / feedback_events 行数在前后不变（零正式记忆污染）；
 * - 默认（无 --commit）在真实库的临时副本上演练，绝不触碰真实库；--commit 才对真实库执行；
 * - taskId 必填（--task-id=<id>），绝不隐式默认；未提供则拒绝执行、不写生产库；
 * - 仅允许重试 failed 任务；写入前打印脱敏 DB 路径 + taskId + 当前状态；
 * - 复用任务冻结的 inputSnapshot（不重跑 snapshot builder、不改任何候选/规则事实）。
 *
 * 用法：tsx scripts/retryAnalysisTask.ts --task-id=<failed 任务 id> [--commit]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectEnv } from '../server/config/loadEnv';
import { openDb } from '../server/db';
import { isLlmConfigured } from '../server/llm/provider';
import { AnalysisService } from '../server/radar/analysis/analysisService';

const REAL_DB = path.resolve('data/offerflow.sqlite3');
const COMMIT = process.argv.includes('--commit');

/** 必填 --task-id=<id>：绝不隐式默认某个任务，避免误重试他人任务。 */
function readTaskId(): string | undefined {
  const hit = process.argv.find((a) => a.startsWith('--task-id='));
  const value = hit?.slice('--task-id='.length).trim();
  return value !== undefined && value !== '' ? value : undefined;
}

/** DB 路径脱敏：只暴露末两级（父目录/文件名），不泄漏完整绝对路径。 */
function maskDbPath(p: string): string {
  return `.../${path.basename(path.dirname(p))}/${path.basename(p)}`;
}

function countMemory(db: ReturnType<typeof openDb>): Record<string, number> {
  const one = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return { jobs: one('jobs'), applications: one('applications'), feedback_events: one('feedback_events') };
}

function taskRow(db: ReturnType<typeof openDb>, id: string) {
  return db
    .prepare(
      `SELECT status, attempt_count AS attemptCount, max_attempts AS maxAttempts,
              error_code AS errorCode, substr(error_message, 1, 400) AS errorMessage,
              result_record_id AS resultRecordId
       FROM analysis_tasks WHERE id = ?`,
    )
    .get(id) as
    | { status: string; attemptCount: number; maxAttempts: number; errorCode: string | null; errorMessage: string | null; resultRecordId: string | null }
    | undefined;
}

async function main(): Promise<void> {
  loadProjectEnv();

  // 必填 taskId：未显式指定则拒绝执行，绝不隐式选中某个任务、绝不写生产库。
  const taskId = readTaskId();
  if (taskId === undefined) {
    console.error('用法：tsx scripts/retryAnalysisTask.ts --task-id=<failed 任务 id> [--commit]');
    console.error('未提供 --task-id：拒绝执行（不演练、不写生产库）。');
    process.exit(1);
  }

  if (!isLlmConfigured()) {
    console.error('LLM 未配置：无法执行真实分析。请确认 server/.env 中的 OFFERFLOW_LLM_* / DEEPSEEK_* 已设置。');
    process.exit(1);
  }

  // dry-run：把真实库复制到临时文件；commit：直接对真实库执行（V8-4 授权范围：仅分析两表）。
  let dbPath = REAL_DB;
  if (!COMMIT) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-retry-'));
    dbPath = path.join(dir, 'copy.sqlite3');
    fs.copyFileSync(REAL_DB, dbPath);
  }

  const db = openDb(dbPath);
  const memoryBefore = countMemory(db);
  const before = taskRow(db, taskId);
  if (before === undefined) {
    console.error('未找到任务：', taskId);
    process.exit(1);
  }

  // 只允许重试 failed 任务：其余状态直接拒绝（不依赖状态机兜底），避免误动 queued/running/succeeded/cancelled。
  if (before.status !== 'failed') {
    console.error(`任务当前状态为 ${before.status}，仅允许重试 failed 任务，拒绝执行。`);
    process.exit(1);
  }

  // 写入前明确打印：脱敏 DB 路径 + taskId + 当前状态（不泄漏完整绝对路径）。
  console.log(COMMIT ? '[commit] 对生产库执行' : '[dry-run] 在生产库副本上演练', {
    db: maskDbPath(dbPath),
    taskId,
    status: before.status,
    attemptCount: before.attemptCount,
    maxAttempts: before.maxAttempts,
    errorCode: before.errorCode,
  });

  const service = new AnalysisService({ db });
  const requeued = service.retryTask(taskId);
  console.log('人工重新分析 → queued：', { status: requeued.status, attemptCount: requeued.attemptCount, maxAttempts: requeued.maxAttempts });

  const outcome = await service.runTask(taskId);
  console.log('运行结果 outcome：', outcome.kind, outcome.kind === 'failed' ? outcome.errorCode : '');

  const after = taskRow(db, taskId);
  console.log('执行后任务：', after);

  const memoryAfter = countMemory(db);
  const memoryUnchanged = JSON.stringify(memoryBefore) === JSON.stringify(memoryAfter);
  console.log('正式记忆行数（前/后）：', memoryBefore, memoryAfter, memoryUnchanged ? '未变' : '变化！');
  if (!memoryUnchanged) {
    console.error('检测到正式记忆变化，违反零污染边界，终止。');
    process.exit(1);
  }

  db.close();
  console.log(COMMIT ? '完成（真实库已更新）。' : '演练完成（真实库未改动）。如结果符合预期，加 --commit 对真实库执行。');
}

void main();
