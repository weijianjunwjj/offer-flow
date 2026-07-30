#!/usr/bin/env node
/** cc-auto CLI 入口：run | resume | report。真实拉起全局 claude CLI，不引入新依赖。 */
import path from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DEFAULT_CONFIG, type CcAutoConfig } from './config';
import { runTask, resumeTask, type OrchestratorDeps } from './orchestrator';
import { runClaude, type ClaudeCallOptions } from './runner';
import { latestRunId, ccAutoRoot, loadRunState } from './store';
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
  };
}

function parseEstimatedFiles(args: string[]): number | undefined {
  const flag = args.find((a) => a.startsWith('--estimated-files='));
  if (!flag) return undefined;
  const value = Number(flag.split('=')[1]);
  return Number.isFinite(value) ? value : undefined;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = DEFAULT_CONFIG;

  if (command === 'run') {
    const taskDescription = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!taskDescription) {
      console.error('用法：pnpm cc:auto run "<任务描述>" [--estimated-files=N]');
      process.exit(1);
    }
    const estimatedFiles = parseEstimatedFiles(rest);
    const deps = buildDeps(config);
    const state = await runTask(deps, taskDescription, estimatedFiles);
    console.log(`\n最终阶段：${state.currentPhase}${state.stopReason ? `（${state.stopReason}）` : ''}`);
    process.exit(state.done && state.currentPhase !== 'STOPPED' ? 0 : 1);
  } else if (command === 'resume') {
    const runId = rest[0] ?? latestRunId(CWD);
    if (!runId) {
      console.error('未找到可 resume 的 run，请显式指定 run-id');
      process.exit(1);
    }
    const deps = buildDeps(config);
    const state = await resumeTask(deps, runId);
    console.log(`\n最终阶段：${state.currentPhase}${state.stopReason ? `（${state.stopReason}）` : ''}`);
    process.exit(state.done && state.currentPhase !== 'STOPPED' ? 0 : 1);
  } else if (command === 'report') {
    const runId = rest[0] ?? latestRunId(CWD);
    if (!runId) {
      console.error('未找到任何 run');
      process.exit(1);
    }
    const state = loadRunState(CWD, runId);
    console.log(renderReport(state));
  } else {
    console.error('用法：pnpm cc:auto <run|resume|report> ...');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[cc-auto] 致命错误：${(err as Error).message}`);
  process.exit(1);
});
