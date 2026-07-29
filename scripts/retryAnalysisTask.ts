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
 * - --validate-fix（只读，与 --commit 互斥）：读任务冻结的 inputSnapshot，直接走生产
 *   编排 generate+repair+解析校验，绕过状态机与 attempt 上限，验证根因修复是否产出合法
 *   Payload。不写任何库、不改 attempt。用于任务已撞 6/6 上限、无法经 retryTask 验证时。
 *
 * - --recover：不原地重试（会撞 attempt 上限），而是为该 failed 任务新建「人工恢复
 *   任务」（新 taskId，复用冻结 inputSnapshot 并注入 recovery:{of,generation}），旧任务
 *   原封不动；随后运行新任务到终态。dry-run 默认演练，--commit 才对真实库执行。
 *
 * - --flake-retries=N（默认 5）：对瞬时网络 flake（connect timeout / fetch failed / 网络
 *   调用失败）的有界自动重试；仅加在本脚本这层，provider retryMax 仍 0，不消耗任务 attempt
 *   预算。绝不重试确定性失败（截断 finish_reason=length / 空内容 / HTTP 状态 / 限流 / 配置）。
 *
 * 用法：tsx scripts/retryAnalysisTask.ts --task-id=<failed 任务 id> [--recover] [--commit] [--debug-output] [--validate-fix] [--flake-retries=N]
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
import { ANALYSIS_MAX_TOKENS, deepSeekJobMatchAnalysisProvider } from '../server/radar/analysis/deepSeekProvider';
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from '../server/radar/analysis/provider';
import { AnalysisService } from '../server/radar/analysis/analysisService';
import { withFlakeRetry } from './flakeRetry';
import { parseJobMatchAnalysisInputSnapshot } from '../server/radar/analysis/contracts';
import { buildJobMatchAnalysisLlmInput } from '../server/radar/analysis/llmInput';
import { generateAndParseJobMatchAnalysis } from '../server/radar/analysis/repair';

const VALIDATE_FIX = process.argv.includes('--validate-fix');
const RECOVER = process.argv.includes('--recover');

/** --flake-retries=N：对瞬时网络 flake（connect timeout / fetch failed）的有界自动重试次数，默认 5。 */
function readFlakeRetries(): number {
  const hit = process.argv.find((a) => a.startsWith('--flake-retries='));
  const n = hit !== undefined ? Number.parseInt(hit.slice('--flake-retries='.length), 10) : 5;
  return Number.isFinite(n) && n >= 0 ? n : 5;
}
const FLAKE_RETRIES = readFlakeRetries();

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
      disableThinking: true, // 与生产 Provider 对齐：关闭思维链，dry-run 才真实反映修复。
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

/** 脚本这层的 flake 重试包装：带日志的 onRetry。逻辑见 scripts/flakeRetry.ts。 */
function wrapFlakeRetry(inner: JobMatchAnalysisProvider): JobMatchAnalysisProvider {
  return withFlakeRetry(inner, FLAKE_RETRIES, (phase, attempt, err) => {
    const msg = err instanceof Error ? err.message.slice(0, 60) : String(err);
    console.log(`[flake-retry] ${phase} 第 ${attempt}/${FLAKE_RETRIES} 次遇瞬时网络 flake，重试：${msg}`);
  });
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

/**
 * 只读校验根因修复（thinking disabled）：不碰任务状态机、不碰真实库、不改 attempt。
 * 复制真实库到临时文件仅为读取冻结 inputSnapshot；调试 Provider（disableThinking:true，
 * 与生产对齐）走生产编排解析校验。校验产出可解析为合法 Payload 即算一次成功。
 */
async function runValidateFix(taskId: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-validate-'));
  const dbPath = path.join(dir, 'copy.sqlite3');
  fs.copyFileSync(REAL_DB, dbPath);
  const db = openDb(dbPath);
  const memoryBefore = countMemory(db);
  const row = db
    .prepare('SELECT status, input_snapshot_json AS snapshotJson FROM analysis_tasks WHERE id = ?')
    .get(taskId) as { status: string; snapshotJson: string } | undefined;
  if (row === undefined) {
    console.error('未找到任务：', taskId);
    process.exit(1);
  }
  console.log('[validate-fix] 只读校验（不写任何库、不改 attempt）', { db: maskDbPath(dbPath), taskId, status: row.status });

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(DEBUG_DIR, `validate-${taskId.slice(-8)}-`));
  const diags: DebugCallInfo[] = [];
  const provider = wrapFlakeRetry(makeDebugProvider(runDir, diags));

  const snapshot = parseJobMatchAnalysisInputSnapshot(JSON.parse(row.snapshotJson));
  const { llmInput, allowedEvidenceKeys } = buildJobMatchAnalysisLlmInput(snapshot);
  const result = await generateAndParseJobMatchAnalysis({ provider, llmInput, allowedEvidenceKeys });

  for (const d of diags) {
    console.log(`[debug] ${d.phase}:`, {
      httpStatus: d.httpStatus, finishReason: d.finishReason, contentLength: d.contentLength,
      reasoningContentLength: d.reasoningContentLength, startsWithBrace: d.startsWithBrace, endsWithBrace: d.endsWithBrace,
    });
  }
  console.log('[validate-fix] 解析校验通过：', {
    repaired: result.repaired,
    recommendation: result.payload.recommendation,
    confidence: result.payload.confidence,
  });

  const memoryUnchanged = JSON.stringify(memoryBefore) === JSON.stringify(countMemory(db));
  console.log('正式记忆行数：', memoryUnchanged ? '未变' : '变化！');
  db.close();
  if (!memoryUnchanged) process.exit(1);
  console.log('[validate-fix] 一次成功（真实库未改动、attempt 未变）。');
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

  // --validate-fix 是只读校验：与 --commit 互斥，绝不写库。
  if (VALIDATE_FIX && COMMIT) {
    console.error('--validate-fix 为只读校验，禁止与 --commit 同用。');
    process.exit(1);
  }

  // --validate-fix 与 --recover 语义互斥（一个只读校验、一个新建并运行任务）。
  if (VALIDATE_FIX && RECOVER) {
    console.error('--validate-fix 与 --recover 不可同用。');
    process.exit(1);
  }

  if (!isLlmConfigured()) {
    console.error('LLM 未配置：无法执行真实分析。请确认 server/.env 中的 OFFERFLOW_LLM_* / DEEPSEEK_* 已设置。');
    process.exit(1);
  }

  // --validate-fix：只读校验根因修复。读副本里冻结的 inputSnapshot，直接走生产编排
  // generateAndParseJobMatchAnalysis（generate + 至多一次 repair + 解析校验），绕过任务
  // 状态机与 attempt 上限（任务已 6/6 撞顶，无法再经 retryTask 验证）。不写任何库、不改 attempt。
  if (VALIDATE_FIX) {
    await runValidateFix(taskId);
    return;
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

  // 统一包一层 flake 重试：debug-output 时包调试 Provider，否则包生产 Provider。
  // 一次 runTask 尝试内部穿越瞬时网络 flake，不消耗任务 attempt 预算。
  const baseProvider = debugProvider ?? deepSeekJobMatchAnalysisProvider;
  const service = new AnalysisService({ db, provider: wrapFlakeRetry(baseProvider) });

  // --recover：为该 failed 任务新建「人工恢复任务」（新 taskId + 关联旧任务），旧任务不动；
  // 否则走原地重试（受 6/6 上限约束）。两条路径都随后 runTask 到终态。
  let runId = taskId;
  if (RECOVER) {
    const { task: recovery, created } = service.createRecoveryTask(taskId);
    runId = recovery.id;
    console.log('人工恢复任务 →', created ? '新建' : '命中已有', {
      newTaskId: recovery.id,
      previousTaskId: taskId,
      status: recovery.status,
      attemptCount: recovery.attemptCount,
    });
  } else {
    const requeued = service.retryTask(taskId);
    console.log('人工重新分析 → queued：', { status: requeued.status, attemptCount: requeued.attemptCount, maxAttempts: requeued.maxAttempts });
  }

  const outcome = await service.runTask(runId);
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

  const after = taskRow(db, runId);
  console.log('执行后任务：', { taskId: runId, ...after });
  if (RECOVER) {
    // 明确核验旧任务未被触碰（保持 failed，attempt 不变）——不可变审计边界。
    console.log('旧任务（应保持不动）：', { taskId, ...taskRow(db, taskId) });
  }

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
