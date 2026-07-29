/**
 * 一次性运维脚本：对指定的 failed 单岗位分析任务执行「人工重新分析 + 运行」。
 *
 * 严格边界：
 * - 只写 analysis_tasks / job_match_analysis_records（V8-4 授权范围内）；
 * - 断言 jobs / applications / feedback_events 行数在前后不变（零正式记忆污染）；
 * - 默认（无 --commit）在真实库的临时副本上演练，绝不触碰真实库；--commit 才对真实库执行；
 * - taskId 必填（--task-id=<id>），绝不隐式默认；未提供则拒绝执行、不写生产库；
 * - 仅允许重试 failed 任务；写入前打印脱敏 DB 路径 + taskId + 当前状态；
 * - 复用任务冻结的 inputSnapshot（不重跑 snapshot builder、不改任何候选/规则事实）；
 * - --debug-output（仅 dry-run，与 --commit 互斥）：记录首次/repair 的 HTTP 状态、
 *   finish_reason、content/reasoning_content 长度，并把原始正文落到 gitignored
 *   .analysis-debug/ 供根因排查；绝不打印 API Key / 正文 / JD，绝不入库。
 *
 * 用法：tsx scripts/retryAnalysisTask.ts --task-id=<failed 任务 id> [--commit] [--debug-output]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProjectEnv } from '../server/config/loadEnv';
import { openDb } from '../server/db';
import { chatCompletion, getLlmConfig, isLlmConfigured, type LlmRawResponseInfo } from '../server/llm/provider';
import {
  JOB_MATCH_ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserMessage,
  buildAnalysisRepairMessage,
} from '../server/radar/analysis/analysisPrompt';
import { ANALYSIS_MAX_TOKENS } from '../server/radar/analysis/deepSeekProvider';
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from '../server/radar/analysis/provider';
import { AnalysisService } from '../server/radar/analysis/analysisService';

const REAL_DB = path.resolve('data/offerflow.sqlite3');
const COMMIT = process.argv.includes('--commit');
const DEBUG_OUTPUT = process.argv.includes('--debug-output');
const DEBUG_DIR = path.resolve('.analysis-debug');

/** 一次调用的稳定诊断（不含正文）：用于打印与判断根因。 */
interface DebugCallInfo {
  phase: 'generate' | 'repair';
  httpStatus: number;
  finishReason: string | null;
  contentLength: number;
  reasoningContentLength: number;
  /** content 前若干字符是否以 '{' 起、是否以 '}' 收（判断截断/多 JSON 线索，不落正文）。 */
  startsWithBrace: boolean;
  endsWithBrace: boolean;
}

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

/**
 * 调试 Provider：仅 dry-run + --debug-output 使用。包装 chatCompletion 捕获每次
 * （generate/repair）的原始响应字段映射，把**原始正文**落到 gitignored 目录，
 * 并收集稳定诊断（不含正文）供根因判断。绝不打印 API Key / 正文 / JD。
 */
function makeDebugProvider(runDir: string, diags: DebugCallInfo[]): JobMatchAnalysisProvider {
  const ANALYSIS_TEMPERATURE = 0.1; // 与生产 Provider 对齐；max_tokens 复用生产常量。

  async function call(phase: 'generate' | 'repair', userMessage: string, signal: AbortSignal | undefined): Promise<AnalysisProviderCallResult> {
    let raw: LlmRawResponseInfo | undefined;
    const result = await chatCompletion(JOB_MATCH_ANALYSIS_SYSTEM_PROMPT, userMessage, {
      maxTokens: ANALYSIS_MAX_TOKENS,
      temperature: ANALYSIS_TEMPERATURE,
      retryMax: 0,
      signal,
      onRawResponse: (info) => { raw = info; },
    });

    if (raw !== undefined) {
      // 原始正文落 gitignored 目录（可能含 JD/正文，绝不入库、绝不打印）。
      fs.writeFileSync(path.join(runDir, `${phase}.content.txt`), raw.content, 'utf8');
      fs.writeFileSync(path.join(runDir, `${phase}.reasoning_content.txt`), raw.reasoningContent, 'utf8');
      const trimmed = raw.content.trim();
      diags.push({
        phase,
        httpStatus: raw.httpStatus,
        finishReason: raw.finishReason,
        contentLength: raw.contentLength,
        reasoningContentLength: raw.reasoningContentLength,
        startsWithBrace: trimmed.startsWith('{'),
        endsWithBrace: trimmed.endsWith('}'),
      });
    }

    if (result.error !== undefined && result.error !== '') {
      throw new AnalysisProviderError('PROVIDER_NETWORK_ERROR', `调试调用失败：${result.error.slice(0, 80)}`);
    }
    if (result.rawText === '') {
      throw new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 返回空内容');
    }
    return { rawText: result.rawText, provider: 'deepseek-debug', model: result.model };
  }

  return {
    isConfigured: isLlmConfigured,
    providerName: () => 'deepseek-debug',
    modelName: () => getLlmConfig().model || 'unknown',
    generate: (input, signal) => call('generate', buildAnalysisUserMessage(input), signal),
    repair: (input, prev, summary, signal) => call('repair', buildAnalysisRepairMessage(input, prev, summary), signal),
  };
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

  // --debug-output 仅限 dry-run：与 --commit 互斥，绝不在写生产库时导出原始响应。
  if (DEBUG_OUTPUT && COMMIT) {
    console.error('--debug-output 仅用于 dry-run，禁止与 --commit 同用（不导出生产写入的原始响应）。');
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

  // --debug-output：注入调试 Provider，把每次调用的原始响应落到 gitignored 目录。
  const diags: DebugCallInfo[] = [];
  let debugProvider: JobMatchAnalysisProvider | undefined;
  let runDir: string | undefined;
  if (DEBUG_OUTPUT) {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    // mkdtempSync 由 OS 追加随机后缀保证唯一（不依赖 Date.now/Math.random）；前缀带 taskId 尾 8 位便于辨认。
    runDir = fs.mkdtempSync(path.join(DEBUG_DIR, `run-${taskId.slice(-8)}-`));
    debugProvider = makeDebugProvider(runDir, diags);
    console.log('[debug-output] 原始响应将落到（gitignored）：', maskDbPath(runDir));
  }

  const service = new AnalysisService(debugProvider !== undefined ? { db, provider: debugProvider } : { db });
  const requeued = service.retryTask(taskId);
  console.log('人工重新分析 → queued：', { status: requeued.status, attemptCount: requeued.attemptCount, maxAttempts: requeued.maxAttempts });

  const outcome = await service.runTask(taskId);
  console.log('运行结果 outcome：', outcome.kind, outcome.kind === 'failed' ? outcome.errorCode : '');

  // 打印稳定诊断（不含正文）：HTTP 状态 / finish_reason / content 长度 / reasoning 长度 / 括号闭合线索。
  if (DEBUG_OUTPUT) {
    for (const d of diags) {
      console.log(`[debug] ${d.phase}:`, {
        httpStatus: d.httpStatus,
        finishReason: d.finishReason,
        contentLength: d.contentLength,
        reasoningContentLength: d.reasoningContentLength,
        startsWithBrace: d.startsWithBrace,
        endsWithBrace: d.endsWithBrace,
      });
    }
    if (diags.length === 0) console.log('[debug] 无调用诊断（可能在调用前失败）。');
  }

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
