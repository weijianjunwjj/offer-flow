/**
 * 一次性运维脚本：对指定的 failed 单岗位分析任务执行「人工重新分析 + 运行」。
 *
 * 严格边界：
 * - 只写 analysis_tasks / job_match_analysis_records（V8-4 授权范围内）；
 * - 断言 jobs / applications / feedback_events 行数在前后不变（零正式记忆污染）；
 * - --dry-run（默认）在真实库的临时副本上演练，绝不触碰真实库；--commit 才对真实库执行；
 * - 复用任务冻结的 inputSnapshot（不重跑 snapshot builder、不改任何候选/规则事实）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectEnv } from '../server/config/loadEnv';
import { openDb } from '../server/db';
import { isLlmConfigured } from '../server/llm/provider';
import { AnalysisService } from '../server/radar/analysis/analysisService';

const REAL_DB = path.resolve('data/offerflow.sqlite3');
const TASK_ID = process.argv.find((a) => a.startsWith('--task='))?.slice('--task='.length)
  ?? 'analysis-task:v1:0746c5f146897fb7a8eb8b0abfdb8d27c2d9e995368e5f52b025a954e0baab9d';
const COMMIT = process.argv.includes('--commit');

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
    console.log('[dry-run] 在真实库副本上演练：', dbPath);
  } else {
    console.log('[commit] 对真实库执行：', REAL_DB);
  }

  const db = openDb(dbPath);
  const memoryBefore = countMemory(db);
  const before = taskRow(db, TASK_ID);
  if (before === undefined) {
    console.error('未找到任务：', TASK_ID);
    process.exit(1);
  }
  console.log('执行前任务：', before);

  const service = new AnalysisService({ db });
  const requeued = service.retryTask(TASK_ID);
  console.log('人工重新分析 → queued：', { status: requeued.status, attemptCount: requeued.attemptCount, maxAttempts: requeued.maxAttempts });

  const outcome = await service.runTask(TASK_ID);
  console.log('运行结果 outcome：', outcome.kind, outcome.kind === 'failed' ? outcome.errorCode : '');

  const after = taskRow(db, TASK_ID);
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
