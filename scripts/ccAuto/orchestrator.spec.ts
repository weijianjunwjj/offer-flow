import { expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runTask, resumeTask } from './orchestrator';
import { DEFAULT_CONFIG, type CcAutoConfig } from './config';
import { createRunState, loadRunState, saveRunState } from './store';
import { customRmbCost, usdToRmb, summarizeUsage } from './budget';
import { renderReport } from './report';
import { classifyTask } from './classify';
import type { ClaudeCallOptions, ClaudeCallResult } from './runner';
import type { CallUsage } from './types';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(os.tmpdir(), 'cc-auto-orch-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const MODEL_ID_BY_ROLE: Record<CallUsage['model'], string> = {
  scout: 'claude-haiku-4-5',
  builder: 'claude-sonnet-5',
  arbiter: 'claude-opus-5',
};

function usage(model: CallUsage['model'], costRmb = 0.01): CallUsage {
  return { model, modelId: MODEL_ID_BY_ROLE[model], inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0.001, costRmbOfficial: costRmb, costRmbCustom: costRmb, costRmb, durationMs: 10, numTurns: 1, pricingStatus: 'PRICED' };
}

function fakeResult(role: CallUsage['model'], structuredOutput: unknown): ClaudeCallResult {
  return { raw: {}, resultText: '', structuredOutput, isError: false, subtype: 'success', usage: usage(role), permissionDenials: [] };
}

it('简单文案任务：跳过 scout/arbiter，一次构建 + 验证通过后 DONE', async () => {
  let builderCalls = 0;
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      builderCalls += 1;
      expect(options.role).toBe('builder');
      return fakeResult('builder', { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false });
    },
    runTests: async () => ({ passed: true, output: 'ok' }),
    runFullVerification: async () => ({ passed: true, output: 'full ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：把按钮文字改成"确认投递"');
  expect(builderCalls).toBe(1);
  expect(state.currentPhase).toBe('DONE');
  expect(state.done).toBe(true);
  expect(loadRunState(cwd, state.runId).currentPhase).toBe('DONE');
});

it('normal 任务：先 scout 再 builder，验证一次通过', async () => {
  const rolesSeen: string[] = [];
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      rolesSeen.push(options.role);
      if (options.role === 'scout') return fakeResult('scout', { relevantFiles: ['x.ts', 'y.ts'] });
      return fakeResult('builder', { summary: 'ok', changedFiles: ['x.ts'], needsArbitration: false });
    },
    runTests: async () => ({ passed: true, output: 'ok' }),
    runFullVerification: async () => ({ passed: true, output: 'full ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修复登录页跳转报错的 bug', 2);
  expect(rolesSeen).toEqual(['scout', 'builder']);
  expect(state.currentPhase).toBe('DONE');
});

it('同一指纹反复失败：第二次起升级仲裁，仲裁配额用尽后 ARBITRATION_FAILED', async () => {
  const rolesSeen: string[] = [];
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      rolesSeen.push(options.role);
      if (options.role === 'scout') return fakeResult('scout', { relevantFiles: ['a.ts'] });
      if (options.role === 'arbiter') return fakeResult('arbiter', { rootCause: 'x', decision: 'retry' });
      return fakeResult('builder', { summary: 'try', changedFiles: ['a.ts'], needsArbitration: false });
    },
    runTests: async () => ({ passed: false, output: 'TypeError: x is not a function' }),
    runFullVerification: async () => ({ passed: false, output: 'TypeError: x is not a function' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修复登录页跳转报错的 bug', 2);
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('ARBITRATION_FAILED');
  // scout, IMPLEMENT(builder), REPAIR_1(builder), ARBITRATE(arbiter), REPAIR_2(builder) — 第二次仲裁被配额拒绝，不再发起调用
  expect(rolesSeen).toEqual(['scout', 'builder', 'builder', 'arbiter', 'builder']);
  expect(state.opusCalls).toBe(1);
});

it('预算超限：任务预算被设为极小值时在首次调用前停止', async () => {
  const tinyConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, simpleTaskRmb: 0, absoluteTaskMaxRmb: 0 } };
  let called = false;
  const deps = {
    cwd, config: tinyConfig,
    runClaude: async (): Promise<ClaudeCallResult> => { called = true; return fakeResult('builder', { summary: 'x', changedFiles: [], needsArbitration: false }); },
    runTests: async () => ({ passed: true, output: '' }),
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案');
  expect(called).toBe(false);
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('BUDGET_TASK_EXCEEDED');
});

it('验收 A：VERIFY 阶段找不到相关测试时自动跑全量测试，不允许跳过判定通过', async () => {
  const testCalls: string[] = [];
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => fakeResult('builder', { summary: 'ok', changedFiles: ['unrelated.ts'], needsArbitration: false }),
    // 模拟 cli.ts 的 runRelatedTests：定位不到任何 spec 时必须退回全量测试，而不是直接判定通过。
    runTests: async (files: string[]) => {
      testCalls.push(`related:${files.join(',')}`);
      return { passed: true, output: '（模拟：定位不到任何测试文件，退回全量测试且全量通过）' };
    },
    runFullVerification: async () => ({ passed: true, output: 'full ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(state.currentPhase).toBe('DONE');
  expect(testCalls.length).toBeGreaterThan(0); // 确认 runTests 确实被调用过，不是被跳过
});

it('flaky 测试：VERIFY 两次同配置重跑结果不一致时 STOPPED(FLAKY_TESTS)', async () => {
  let call = 0;
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => fakeResult('builder', { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false }),
    runTests: async () => {
      call += 1;
      return { passed: call % 2 === 1 ? false : true, output: `run#${call}` }; // 第一次失败，第二次通过 -> 不稳定
    },
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('FLAKY_TESTS');
  expect(call).toBe(2); // 确认确实重跑了一次同配置校验，而不是直接采信第一次结果
});

it('FINAL_VERIFY 必须调用全量校验（typecheck + 全量 vitest），而不是复用定向 VERIFY 的结果', async () => {
  let relatedCalls = 0;
  let fullCalls = 0;
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => fakeResult('builder', { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false }),
    runTests: async () => { relatedCalls += 1; return { passed: true, output: 'related ok' }; },
    runFullVerification: async () => { fullCalls += 1; return { passed: true, output: 'full ok' }; },
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(state.currentPhase).toBe('DONE');
  expect(relatedCalls).toBe(1); // VERIFY 用定向校验
  expect(fullCalls).toBe(1); // FINAL_VERIFY 必须单独调用全量校验，不能省略
});

it('验收 C：Opus 仲裁 cwd 不是仓库根目录，且不开放任何文件类工具（Read/Write/Edit/Bash/Glob/Grep 均不可用）', async () => {
  let arbiterCwd: string | undefined;
  let arbiterTools: string[] | undefined;
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      if (options.role === 'scout') return fakeResult('scout', { relevantFiles: ['a.ts'] });
      if (options.role === 'arbiter') {
        arbiterCwd = options.cwd;
        arbiterTools = options.tools;
        return fakeResult('arbiter', { rootCause: 'x', decision: 'retry' });
      }
      return fakeResult('builder', { summary: 'try', changedFiles: ['a.ts'], needsArbitration: false });
    },
    runTests: async () => ({ passed: false, output: 'TypeError: x is not a function' }),
    runFullVerification: async () => ({ passed: false, output: 'TypeError: x is not a function' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  await runTask(deps, '修复登录页跳转报错的 bug', 2);
  expect(arbiterCwd).toBeDefined();
  expect(arbiterCwd).not.toBe(cwd); // 不得以仓库根目录为 cwd
  expect(arbiterCwd!.startsWith(cwd)).toBe(false); // 不得是仓库子目录
  expect(arbiterTools).toEqual([]); // 不开放任何工具，包括 Read
});

it('验收 B：自定义渠道价格能正确触发预算停止（官方 CLI 费用极低但渠道估算超预算）', async () => {
  // official 总是报 0.001 USD（≈0.007 元），远低于任务预算；custom 渠道单价故意设得很高，
  // 使得同样的 token 用量在 custom 口径下会超出极小的任务预算，从而在第二次调用前被拦截。
  const expensiveConfig: CcAutoConfig = {
    ...DEFAULT_CONFIG,
    pricingMode: 'custom',
    // 预算上限设在「调用前粗估(1.5元/次 builder)」和「custom 真实费用(约 20 元)」之间：
    // 第一次调用能通过调用前的粗估闭环，调用返回后按 custom 单价算出的真实花费才会超限，
    // 从而在第二次调用前被拦截——这样才能证明是「返回后按渠道单价计算的真实费用」驱动了停止。
    budget: { ...DEFAULT_CONFIG.budget, simpleTaskRmb: 2, absoluteTaskMaxRmb: 2 },
    customPricing: {
      ...DEFAULT_CONFIG.customPricing,
      'claude-sonnet-5': { inputPerMTokens: 1_000_000, outputPerMTokens: 1_000_000, cacheCreationPerMTokens: 1_000_000, cacheReadPerMTokens: 1_000_000 },
    },
  };
  // 用真实的 customRmbCost 计算这次调用在两种口径下各是多少钱，而不是手写一个任意大数——
  // 这样才能证明「是自定义渠道单价表本身」驱动了停止，不是别的东西。预算止损恒依据 custom 口径。
  const tokens = { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  const costUsd = 0.001;
  const official = usdToRmb(costUsd, expensiveConfig);
  const customResult = customRmbCost('claude-sonnet-5', tokens, expensiveConfig);
  expect(customResult.ok).toBe(true);
  const custom = customResult.cost;
  expect(custom).toBeGreaterThan(expensiveConfig.budget.absoluteTaskMaxRmb); // 确认 custom 单价确实会超预算
  expect(official).toBeLessThan(expensiveConfig.budget.absoluteTaskMaxRmb); // 确认换成 official 口径本不会超预算

  const builderUsage: CallUsage = {
    model: 'builder', modelId: 'claude-sonnet-5', ...tokens,
    costUsd, costRmbOfficial: official, costRmbCustom: custom, costRmb: custom,
    durationMs: 10, numTurns: 1, pricingStatus: 'PRICED',
  };
  let builderCalls = 0;
  const deps = {
    cwd, config: expensiveConfig,
    runClaude: async (): Promise<ClaudeCallResult> => {
      builderCalls += 1;
      return { raw: {}, resultText: '', structuredOutput: { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false }, isError: false, subtype: 'success', usage: builderUsage, permissionDenials: [] };
    },
    runTests: async () => ({ passed: false, output: 'still failing' }),
    runFullVerification: async () => ({ passed: false, output: 'still failing' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  // 第一次 builder 调用发生（调用前预算估算按角色粗估，不知道真实渠道单价），
  // 调用返回后按 custom 单价算出的真实 costRmb 远超预算，下一次调用前的预算闭环必须拦截。
  expect(builderCalls).toBe(1);
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('BUDGET_TASK_EXCEEDED');
});

it('验收 D：返回的模型 ID 未在价格表中时立即停止（PRICING_NOT_FOUND），但该调用仍被完整记录为 UNPRICED（费用为 null，不写成 0）', async () => {
  // UNPRICED：调用已经真实发生，无法定价——modelId、四类 Token、官方参考费用、role、耗时都必须保留，
  // 只有渠道人民币费用为 null（绝不写成 0）。
  const unknownUsage: CallUsage = {
    model: 'builder', modelId: 'claude-unreleased-model',
    inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: 0.001, costRmbOfficial: 0.007, costRmbCustom: null, costRmb: null,
    durationMs: 10, numTurns: 1, pricingStatus: 'UNPRICED',
  };
  let builderCalls = 0;
  let recordedSpend = 0;
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => {
      builderCalls += 1;
      return {
        raw: {}, resultText: '', structuredOutput: { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false },
        isError: false, subtype: 'success', usage: unknownUsage, permissionDenials: [],
        pricingError: { modelId: 'claude-unreleased-model' },
      };
    },
    runTests: async () => ({ passed: true, output: 'ok' }),
    runFullVerification: async () => ({ passed: true, output: 'full ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: (rmb: number) => { recordedSpend += rmb; },
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(builderCalls).toBe(1);
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('PRICING_NOT_FOUND');
  expect(state.stopDetail).toContain('claude-unreleased-model'); // 报告须显示未知模型 ID
  // 关键契约（已废弃旧的 calls.length===0）：无法定价的调用仍要被完整记录，不得丢弃。
  expect(state.calls.length).toBe(1);
  const recorded = state.calls[0];
  expect(recorded.pricingStatus).toBe('UNPRICED');
  expect(recorded.modelId).toBe('claude-unreleased-model');
  expect(recorded.costRmbCustom).toBeNull(); // 不得写成 0
  expect(recorded.costRmb).toBeNull();
  expect(recorded.inputTokens).toBe(10); // 四类 token 仍保留
  expect(recorded.costRmbOfficial).toBeCloseTo(0.007); // 官方参考费用仍保留
  expect(recordedSpend).toBe(0); // UNPRICED（null 费用）不得累计当日花费，也不得当成 0 之外的任何值
});

// 一个配置：builderDefault 指向价格表里没有的模型 ID。用于证明「启动前配置级定价校验」。
function configMissingBuilderPrice(): CcAutoConfig {
  return {
    ...DEFAULT_CONFIG,
    models: {
      ...DEFAULT_CONFIG.models,
      builderDefault: { ...DEFAULT_CONFIG.models.builderDefault, model: 'claude-not-in-price-table' },
    },
  };
}

it('验收 E（run）：配置的模型未在价格表中时，run 在启动任何 claude 子进程之前就 STOPPED(PRICING_NOT_FOUND)，runClaude 从未被调用', async () => {
  let runClaudeCalled = false;
  const deps = {
    cwd, config: configMissingBuilderPrice(),
    runClaude: async (): Promise<ClaudeCallResult> => { runClaudeCalled = true; return fakeResult('builder', { summary: 'x', changedFiles: [], needsArbitration: false }); },
    runTests: async () => ({ passed: true, output: '' }),
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(runClaudeCalled).toBe(false); // 证明未启动任何子进程
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('PRICING_NOT_FOUND');
  expect(state.stopDetail).toContain('claude-not-in-price-table'); // 报告须指出缺价的模型 ID
  expect(state.calls.length).toBe(0); // 没有任何调用发生
});

it('验收 E（resume）：resume 一个进行中的 run 时同样先做启动前定价校验，缺价即 STOPPED(PRICING_NOT_FOUND)，runClaude 从未被调用', async () => {
  // 造一个「进行中」的 run：已过 CLASSIFY，停在 IMPLEMENT，resume 时下一步本应拉起 builder 子进程。
  const state = createRunState(cwd, 'run-resume-pricing', '修复登录页跳转报错的 bug', DEFAULT_CONFIG.pricingMode);
  state.classification = classifyTask(state.taskDescription, 2);
  state.currentPhase = 'IMPLEMENT';
  saveRunState(cwd, state);

  let runClaudeCalled = false;
  const deps = {
    cwd, config: configMissingBuilderPrice(),
    runClaude: async (): Promise<ClaudeCallResult> => { runClaudeCalled = true; return fakeResult('builder', { summary: 'x', changedFiles: [], needsArbitration: false }); },
    runTests: async () => ({ passed: true, output: '' }),
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const resumed = await resumeTask(deps, 'run-resume-pricing');
  expect(runClaudeCalled).toBe(false); // resume 路径也必须在 spawn 前拦截
  expect(resumed.currentPhase).toBe('STOPPED');
  expect(resumed.stopReason).toBe('PRICING_NOT_FOUND');
  expect(resumed.stopDetail).toContain('claude-not-in-price-table');
});

it('验收 F（报告）：UNPRICED 调用计入调用数/Token/官方费用但不计入渠道合计，报告标注费用下限与未定价明细', () => {
  const calls: CallUsage[] = [
    usage('builder', 1.23), // PRICED
    {
      model: 'builder', modelId: 'claude-unreleased-model',
      inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5,
      costUsd: 0.002, costRmbOfficial: 0.0144, costRmbCustom: null, costRmb: null,
      durationMs: 20, numTurns: 2, pricingStatus: 'UNPRICED',
    },
  ];
  const totals = summarizeUsage(calls);
  expect(totals.callCount).toBe(2); // UNPRICED 计入调用数
  expect(totals.unpricedCount).toBe(1);
  expect(totals.hasUnpriced).toBe(true);
  expect(totals.totalRmbCustom).toBeCloseTo(1.23); // 渠道合计只含 PRICED
  expect(totals.totalRmbOfficial).toBeCloseTo(1.23 + 0.0144); // 官方费用含 UNPRICED（usage() 的 costRmbOfficial=costRmb）
  expect(Number.isNaN(totals.totalRmb)).toBe(false); // 不得出现 NaN

  const state = createRunState(cwd, 'run-report-unpriced', '演示报告', DEFAULT_CONFIG.pricingMode);
  state.calls = calls;
  const md = renderReport(state);
  expect(md).toContain('费用下限'); // 明确说明已知合计只是下限
  expect(md).toContain('UNPRICED');
  expect(md).toContain('未定价调用'); // 单独列出未定价调用
  expect(md).toContain('claude-unreleased-model');
  expect(md).not.toContain('null'); // 不得出现 null.toFixed 之类的裸 null
  expect(md).toContain('未定价'); // 表格单元格用「未定价」而非 0
});
