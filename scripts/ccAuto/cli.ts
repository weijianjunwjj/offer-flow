#!/usr/bin/env node
/** cc-auto CLI 入口：run | resume | report。真实拉起全局 claude CLI，不引入新依赖。 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, type CcAutoConfig } from './config';
import { runTask, resumeTask, type OrchestratorDeps } from './orchestrator';
import { runClaude, verifyClaudeBinary, type ClaudeCallOptions } from './runner';
import { latestRunId, ccAutoRoot, loadRunState, isTaskSucceeded } from './store';
import { renderReport } from './report';

const CWD = process.cwd();
const HOOK_SCRIPT_PATH = path.join('scripts', 'ccAuto', 'hookScript.cjs');

function hookSettingsInlineJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT_PATH}` }] },
        { matcher: 'Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT_PATH}` }] },
      ],
    },
  });
}

function dailySpendFile(): string {
  const dir = path.join(ccAutoRoot(CWD), 'daily');
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${today}.json`);
}

function readDailySpend(): number {
  const file = dailySpendFile();
  if (!existsSync(file)) return 0;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { totalRmb?: number };
    return data.totalRmb ?? 0;
  } catch {
    return 0;
  }
}

function writeDailySpend(deltaRmb: number): void {
  const file = dailySpendFile();
  const current = readDailySpend();
  writeFileSync(file, JSON.stringify({ totalRmb: current + deltaRmb }, null, 2), 'utf8');
}

function runVitest(targets: string[]): { passed: boolean; output: string } {
  try {
    const output = execFileSync('pnpm', ['vitest', 'run', ...targets], { cwd: CWD, encoding: 'utf8' });
    return { passed: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { passed: false, output: `${e.stdout ?? ''}\n${e.stderr ?? e.message}` };
  }
}

/** 同名 spec：a/b.ts -> a/b.spec.ts。 */
function sameNameSpecs(files: string[]): string[] {
  return files
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => f.replace(/\.ts$/, '.spec.ts'))
    .filter((f) => existsSync(path.join(CWD, f)));
}

/** 同目录下的所有 *.spec.ts：定位不到同名 spec 时，退回「同模块」范围。 */
function sameModuleSpecs(files: string[]): string[] {
  const dirs = new Set(files.map((f) => path.dirname(f)));
  const specs: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(CWD, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.spec.ts')) specs.push(path.join(dir, entry.name));
    }
  }
  return Array.from(new Set(specs));
}

/**
 * 定向验证：同名 spec -> 同模块 spec -> 全量测试。任何一级找不到测试文件都不允许直接判定通过，
 * 必须继续下沉到下一级，最终至少兜底跑一次全量 vitest，不允许「跳过验证=通过」。
 */
async function runRelatedTests(files: string[]): Promise<{ passed: boolean; output: string }> {
  const explicitSpecs = files.filter((f) => f.endsWith('.spec.ts') && existsSync(path.join(CWD, f)));
  const sameName = sameNameSpecs(files);
  let targets = Array.from(new Set([...sameName, ...explicitSpecs]));
  if (targets.length === 0) {
    targets = sameModuleSpecs(files);
  }
  if (targets.length === 0) {
    return runVitest([]); // 全量测试，不带文件过滤
  }
  return runVitest(targets);
}

/** FINAL_VERIFY 专用：至少跑一次全量 typecheck 和一次全量 vitest，不接受任何定向子集替代。 */
async function runFullVerification(): Promise<{ passed: boolean; output: string }> {
  const typecheck = (() => {
    try {
      const output = execFileSync('pnpm', ['typecheck'], { cwd: CWD, encoding: 'utf8' });
      return { passed: true, output };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { passed: false, output: `${e.stdout ?? ''}\n${e.stderr ?? e.message}` };
    }
  })();
  if (!typecheck.passed) return { passed: false, output: `[typecheck 失败]\n${typecheck.output}` };
  const tests = runVitest([]);
  return { passed: tests.passed, output: `[typecheck 通过]\n${typecheck.output}\n\n[全量 vitest]\n${tests.output}` };
}

function buildDeps(config: CcAutoConfig): OrchestratorDeps {
  return {
    cwd: CWD,
    config,
    runClaude: (options: ClaudeCallOptions) => runClaude(options, config),
    runTests: runRelatedTests,
    runFullVerification,
    currentDailyRmb: readDailySpend,
    recordDailySpend: writeDailySpend,
    hookSettingsInlineJson: hookSettingsInlineJson(),
    log: (line: string) => console.log(`[cc-auto] ${line}`),
    verifyClaudeBinary,
  };
}


/**
 * 取值型 flag：既支持新格式 `--key=value`，也兼容旧调用方式 `--key value`（空格分隔，下一个 token 是值）。
 * 不在此列表中的 `--flag` 视为布尔开关（如 --no-commit），不会消费下一个 token，
 * 从而保证旧式 `--budget 2.00 --max-files 2 ...` 调用不会把数值拼进任务正文。
 *
 * max-repairs 与 max-fix-rounds 是历史别名，统一映射到同一个内部键（见 normalizeFlag）。
 */
const VALUE_FLAGS = new Set(['estimated-files', 'budget', 'max-files', 'max-fix-rounds', 'max-repairs']);

/** 归一化 flag 键：将历史别名统一映射到标准键，避免重复判断。 */
function normalizeFlag(key: string): string {
  if (key === 'max-repairs') return 'max-fix-rounds';
  return key;
}

/**
 * 真实 CLI 参数解析：支持 `--key=value` 与 `--key value` 两种形式，
 * 过滤独立的 `--` 分隔符（pnpm 用于分隔 pnpm 自身参数与脚本参数），
 * 并对历史别名做归一化（max-repairs -> max-fix-rounds）。
 */
export function parseFlags(args: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    // 跳过独立的 `--` 分隔符（pnpm 用于分隔参数边界）
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineVal] = arg.slice(2).split('=', 2);
    const key = normalizeFlag(rawKey);
    if (inlineVal !== undefined) {
      flags.set(key, inlineVal);
      continue;
    }
    if (VALUE_FLAGS.has(rawKey) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags.set(key, args[i + 1]);
      i += 1; // 消费下一个 token 作为该 flag 的值，防止其落入 positional
    } else {
      flags.set(key, 'true');
    }
  }
  return { flags, positional };
}

/**
 * package.json 的 cc:auto 脚本已经绑定了 `run` 子命令；若调用方又手动追加一次
 * `pnpm cc:auto run "<任务>"`，第二个 "run" 会成为 positional[0]，与真实任务描述无关。
 * 兼容旧调用习惯：剥离这个多余的子命令 token，而不是让它污染任务正文。
 * 抽成纯函数，便于不拉起真实模型即可单测。
 */
export function stripDuplicateRunToken(positional: string[]): { positional: string[]; stripped: boolean } {
  if (positional[0] === 'run') {
    return { positional: positional.slice(1), stripped: true };
  }
  return { positional, stripped: false };
}

export interface ParsedRunArgv {
  command: string | undefined;
  taskDescription: string;
  budget?: number;
  maxFiles?: number;
  maxRepairs?: number;
  estimatedFiles?: number;
  noCommit: boolean;
  strippedDuplicateRun: boolean;
}

/**
 * 解析完整的真实 `process.argv`（含 node 可执行文件路径、脚本路径），
 * 覆盖 `pnpm cc:auto -- --budget 2.00 ...` 场景：package.json 预置的 `run` 子命令
 * + pnpm 的 `--` 分隔符 + 取值型 flag + 用户误重复输入 `run` 的兼容场景。
 * 纯函数、无 IO，main() 与 argv 级集成测试共用同一条解析路径。
 */
export function parseRunArgv(argv: string[]): ParsedRunArgv {
  const [command, ...rest] = argv.slice(2);
  const { flags, positional: rawPositional } = parseFlags(rest);
  const { positional, stripped } = stripDuplicateRunToken(rawPositional);
  return {
    command,
    taskDescription: positional.join(' ').trim(),
    budget: flags.has('budget') ? Number(flags.get('budget')) : undefined,
    maxFiles: flags.has('max-files') ? Number(flags.get('max-files')) : undefined,
    maxRepairs: flags.has('max-fix-rounds') ? Number(flags.get('max-fix-rounds')) : undefined,
    estimatedFiles: flags.has('estimated-files') ? Number(flags.get('estimated-files')) : undefined,
    noCommit: flags.get('no-commit') === 'true',
    strippedDuplicateRun: stripped,
  };
}

async function main(): Promise<void> {
  const parsed = parseRunArgv(process.argv);
  const command = parsed.command;
  const config = DEFAULT_CONFIG;

  if (command === 'run') {
    if (parsed.strippedDuplicateRun) {
      console.log('[cc-auto] 检测到重复的 run 子命令（pnpm cc:auto 脚本已内置 run），已剥离，不计入任务正文');
    }
    const taskDescription = parsed.taskDescription;
    if (!taskDescription) {
      console.error('用法：pnpm cc:auto run "<任务描述>" [--estimated-files=N] [--budget=N] [--max-files=N] [--max-fix-rounds=N] [--no-commit]');
      process.exit(1);
    }
    const estimatedFiles = parsed.estimatedFiles;
    const deps = buildDeps(config);
    const state = await runTask(deps, taskDescription, estimatedFiles);
    console.log(`\n最终阶段：${state.currentPhase}${state.stopReason ? `（${state.stopReason}）` : ''}`);
    process.exit(isTaskSucceeded(state) ? 0 : 1);
  } else if (command === 'resume') {
    const { positional } = parseFlags(process.argv.slice(3));
    const runId = positional[0] ?? latestRunId(CWD);
    if (!runId) {
      console.error('未找到可 resume 的 run，请显式指定 run-id');
      process.exit(1);
    }
    const deps = buildDeps(config);
    const state = await resumeTask(deps, runId);
    console.log(`\n最终阶段：${state.currentPhase}${state.stopReason ? `（${state.stopReason}）` : ''}`);
    process.exit(isTaskSucceeded(state) ? 0 : 1);
  } else if (command === 'report') {
    const { positional } = parseFlags(process.argv.slice(3));
    const runId = positional[0] ?? latestRunId(CWD);
    if (!runId) {
      console.error('未找到任何 run');
      process.exit(1);
    }
    const state = loadRunState(CWD, runId);
    console.log(renderReport(state));
  } else if (command === '--help' || command === '-h') {
    console.log('用法：pnpm cc:auto <run|resume|report> ...');
    console.log('');
    console.log('  run "<任务>" [--estimated-files=N] [--budget=N] [--max-files=N] [--max-fix-rounds=N] [--no-commit]');
    console.log('    启动新任务');
    console.log('');
    console.log('  resume [run-id]');
    console.log('    恢复未完成的任务，默认恢复最后一个');
    console.log('');
    console.log('  report [run-id]');
    console.log('    查看指定运行任务的模型调用、渠道费用和验证结果，默认显示最后一个');
  } else {
    console.error('用法：pnpm cc:auto <run|resume|report> ...');
    process.exit(1);
  }
}

/** 仅作为直接执行入口时才运行；被测试 import 时不触发真实 main()。 */
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[cc-auto] 致命错误：${(err as Error).message}`);
    process.exit(1);
  });
}
