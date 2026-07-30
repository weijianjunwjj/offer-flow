/** 一次性演示脚本：模拟场景 B（两文件 bug，Haiku 探路 + Sonnet 构建），不发起任何真实 claude 调用。 */
import { runTask } from '../orchestrator';
import { DEFAULT_CONFIG } from '../config';
import type { ClaudeCallOptions, ClaudeCallResult } from '../runner';
import type { CallUsage } from '../types';

const demoCwd = process.argv[2];
if (!demoCwd) throw new Error('用法：tsx demoRun.ts <cwd>');

function usage(model: CallUsage['model'], costRmb: number): CallUsage {
  return { model, modelId: model === 'scout' ? 'claude-haiku-4-5' : 'claude-sonnet-5', inputTokens: 3000, outputTokens: 800, cacheCreationInputTokens: 500, cacheReadInputTokens: 12000, costUsd: costRmb / DEFAULT_CONFIG.usdToRmbRate, costRmbOfficial: costRmb, costRmbCustom: costRmb, costRmb, durationMs: 8000, numTurns: 3, pricingStatus: 'PRICED' };
}

function fakeResult(role: CallUsage['model'], structuredOutput: unknown, costRmb: number): ClaudeCallResult {
  return { raw: {}, resultText: '', structuredOutput, isError: false, subtype: 'success', usage: usage(role, costRmb), permissionDenials: [] };
}

async function main() {
  const state = await runTask({
    cwd: demoCwd,
    config: DEFAULT_CONFIG,
    runClaude: async (options: ClaudeCallOptions) => {
      if (options.role === 'scout') return fakeResult('scout', { relevantFiles: ['src/app/login.ts', 'src/app/login.spec.ts'] }, 0.02);
      return fakeResult('builder', { summary: '修复登录跳转空指针', changedFiles: ['src/app/login.ts', 'src/app/login.spec.ts'], needsArbitration: false }, 0.35);
    },
    runTests: async () => ({ passed: true, output: '2 passed' }),
    runFullVerification: async () => ({ passed: true, output: 'typecheck+vitest ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: (line) => console.log(`[demo] ${line}`),
  }, '修复登录页跳转报错的 bug（两文件）', 2);

  console.log(`\nrunId=${state.runId}`);
}

main();
