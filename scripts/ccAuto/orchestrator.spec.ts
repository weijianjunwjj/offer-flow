import { expect, it, describe, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { runTask, resumeTask, builderPrompt, extractExplicitFiles, directEditPrompt } from './orchestrator';
import { DEFAULT_CONFIG, type CcAutoConfig } from './config';
import { createRunState, loadRunState, saveRunState } from './store';
import { customRmbCost, usdToRmb, summarizeUsage } from './budget';
import { renderReport } from './report';
import { classifyTask } from './classify';
import {
  evaluateDirectEditEligibility, prepareDirectEditContext, validateDirectEdits, applyDirectEdits,
  isPathWithinRepo, resolveExplicitFileReferences, type PreparedFile,
} from './directEdit';
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
  return { callId: 'test-call', model, modelId: MODEL_ID_BY_ROLE[model], inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0.001, costRmbOfficial: costRmb, costRmbCustom: costRmb, costRmb, durationMs: 10, numTurns: 1, pricingStatus: 'PRICED', subtype: 'success', isError: false, permissionDenialsCount: 0 };
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

it('仲裁前预算门禁拦截：Arbiter 子进程未启动 → runClaude 未被以 arbiter 调用、state.calls 不增、opusCalls 恒为 0、报告不称 Opus 已被调用', async () => {
  // 任务上限设为 2 元；builder 首轮真实花费接近上限，使得下一次 arbiter 调用的调用前粗估（3 元）
  // 叠加已花费后必然超限，从而在真正 spawn arbiter 之前被预算门禁拦截。
  const cfg: CcAutoConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, simpleTaskRmb: 2, absoluteTaskMaxRmb: 2 } };
  const roles: string[] = [];
  const priced = (model: CallUsage['model'], rmb: number): CallUsage => ({
    callId: 'test-call', model, modelId: MODEL_ID_BY_ROLE[model], inputTokens: 10, outputTokens: 10,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: 0.01, costRmbOfficial: rmb, costRmbCustom: rmb, costRmb: rmb,
    durationMs: 10, numTurns: 1, pricingStatus: 'PRICED', subtype: 'success', isError: false, permissionDenialsCount: 0,
  });
  const deps = {
    cwd, config: cfg,
    runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
      roles.push(options.role);
      if (options.role === 'scout') {
        return { raw: {}, resultText: '', structuredOutput: { relevantFiles: ['a.ts'] }, isError: false, subtype: 'success', usage: priced('scout', 0.05), permissionDenials: [] };
      }
      // builder 触发 needsArbitration 以进入 ARBITRATE；返回接近预算上限的真实花费（1.9 元）。
      return { raw: {}, resultText: '', structuredOutput: { summary: 'x', changedFiles: ['a.ts'], needsArbitration: true, arbitrationReason: '需要仲裁' }, isError: false, subtype: 'success', usage: priced('builder', 1.9), permissionDenials: [] };
    },
    runTests: async () => ({ passed: true, output: 'ok' }),
    runFullVerification: async () => ({ passed: true, output: 'full ok' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修复登录页跳转报错的 bug', 2);
  // 只有一次 builder 调用真实发生；arbiter 在预算门禁前被拦截，从未以 arbiter 角色调用 runClaude。
  expect(roles).toEqual(['scout', 'builder']);
  expect(roles).not.toContain('arbiter');
  expect(state.calls.length).toBe(2); // 只有 scout + builder；arbiter 未 push 任何 usage
  expect(state.opusCalls).toBe(0); // 关键：预算门禁前拦截不得虚增 opusCalls
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('BUDGET_TASK_EXCEEDED');
  // 报告不得声称 Opus 已被调用：arbiter 费用为 0、无 arbiter 调用记录。
  const md = renderReport(state);
  expect(md).toContain('arbiter（仲裁）：约 0.00 元');
  expect(state.calls.some((c) => c.model === 'arbiter')).toBe(false);
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
    callId: 'test-call', model: 'builder', modelId: 'claude-sonnet-5', ...tokens,
    costUsd, costRmbOfficial: official, costRmbCustom: custom, costRmb: custom,
    durationMs: 10, numTurns: 1, pricingStatus: 'PRICED',
    subtype: 'success', isError: false, permissionDenialsCount: 0,
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
    callId: 'test-call', model: 'builder', modelId: 'claude-unreleased-model',
    inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: 0.001, costRmbOfficial: 0.007, costRmbCustom: null, costRmb: null,
    durationMs: 10, numTurns: 1, pricingStatus: 'UNPRICED',
    subtype: 'success', isError: false, permissionDenialsCount: 0,
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
      callId: 'test-call', model: 'builder', modelId: 'claude-unreleased-model',
      inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5,
      costUsd: 0.002, costRmbOfficial: 0.0144, costRmbCustom: null, costRmb: null,
      durationMs: 20, numTurns: 2, pricingStatus: 'UNPRICED',
      subtype: 'success', isError: false, permissionDenialsCount: 0,
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

it('验收 G：builder 用尽 max-turns 且未输出结构化 JSON 时分类为 MAX_TURNS_EXCEEDED，不再落入 PROVIDER_ERROR', async () => {
  const maxTurnsUsage: CallUsage = {
    callId: 'test-call', model: 'builder', modelId: 'claude-sonnet-5', inputTokens: 5000, outputTokens: 100,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 270000,
    costUsd: 0.05, costRmbOfficial: 0.36, costRmbCustom: 0.36, costRmb: 0.36,
    durationMs: 60000, numTurns: 16, pricingStatus: 'PRICED',
    subtype: 'error_max_turns', isError: true, permissionDenialsCount: 0,
  };
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => ({
      raw: {}, resultText: '', structuredOutput: undefined, isError: true, subtype: 'error_max_turns',
      usage: maxTurnsUsage, permissionDenials: [],
    }),
    runTests: async () => ({ passed: true, output: '' }),
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('MAX_TURNS_EXCEEDED');
  expect(state.stopReason).not.toBe('PROVIDER_ERROR');
});

it('验收 H：builder 正常结束但缺少结构化输出（非 error_max_turns）时分类为 STRUCTURED_OUTPUT_MISSING', async () => {
  const noStructuredUsage: CallUsage = {
    callId: 'test-call', model: 'builder', modelId: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50,
    cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    costUsd: 0.001, costRmbOfficial: 0.007, costRmbCustom: 0.007, costRmb: 0.007,
    durationMs: 500, numTurns: 3, pricingStatus: 'PRICED',
    subtype: 'success', isError: false, permissionDenialsCount: 0,
  };
  const deps = {
    cwd, config: DEFAULT_CONFIG,
    runClaude: async (): Promise<ClaudeCallResult> => ({
      raw: {}, resultText: '完成了，但忘了按 schema 输出', structuredOutput: undefined, isError: false, subtype: 'success',
      usage: noStructuredUsage, permissionDenials: [],
    }),
    runTests: async () => ({ passed: true, output: '' }),
    runFullVerification: async () => ({ passed: true, output: '' }),
    currentDailyRmb: () => 0,
    recordDailySpend: () => {},
    hookSettingsInlineJson: '{}',
    log: () => {},
  };
  const state = await runTask(deps, '修改文案：调整按钮文案');
  expect(state.currentPhase).toBe('STOPPED');
  expect(state.stopReason).toBe('STRUCTURED_OUTPUT_MISSING');
});

describe('builderPrompt / extractExplicitFiles：simple 任务收敛提示', () => {
  it('extractExplicitFiles 从任务正文中提取显式文件路径', () => {
    const files = extractExplicitFiles('优化 scripts/ccAuto/cli.ts 中 report 子命令的一处帮助文案，同步更新 scripts/ccAuto/cli.spec.ts');
    expect(files).toEqual(['scripts/ccAuto/cli.ts', 'scripts/ccAuto/cli.spec.ts']);
  });

  it('simple 任务且任务正文含显式文件时，注入禁止全仓探索 + 立即收敛的规则', () => {
    const task = '优化 scripts/ccAuto/cli.ts 中 report 子命令的一处帮助文案';
    const prompt = builderPrompt(task, [], undefined, 'simple');
    expect(prompt).toContain('禁止进行全仓探索');
    expect(prompt).toContain('立即输出结构化 JSON');
    expect(prompt).toContain('scripts/ccAuto/cli.ts');
  });

  it('normal/complex 任务即使含显式文件也不注入收敛规则（不改变现有复杂任务路由）', () => {
    const task = '重构 scripts/ccAuto/cli.ts 的整体架构';
    expect(builderPrompt(task, [], undefined, 'normal')).not.toContain('禁止进行全仓探索');
    expect(builderPrompt(task, [], undefined, 'complex')).not.toContain('禁止进行全仓探索');
  });

  it('simple 任务但正文没有显式文件时不注入收敛规则（无法收敛到不存在的目标）', () => {
    const prompt = builderPrompt('修改按钮文案', [], undefined, 'simple');
    expect(prompt).not.toContain('禁止进行全仓探索');
  });
});

describe('renderReport：四类 token 与可观测性明细必须出现在报告中', () => {
  it('报告表格包含输入/输出/缓存写/缓存读四类 token 列及对应数值', () => {
    const state = createRunState(cwd, 'run-report-tokens', '演示任务', 'custom');
    state.calls = [
      {
        callId: 'test-call',
        model: 'builder', modelId: 'claude-sonnet-5',
        inputTokens: 111, outputTokens: 222, cacheCreationInputTokens: 333, cacheReadInputTokens: 444,
        costUsd: 0.01, costRmbOfficial: 0.07, costRmbCustom: 0.07, costRmb: 0.07,
        durationMs: 100, numTurns: 2, pricingStatus: 'PRICED',
        subtype: 'success', isError: false, permissionDenialsCount: 0,
        toolUseCounts: { Read: 3, Edit: 1 },
        toolErrorCounts: { Bash: 1 },
        mcpServers: [],
        lastAssistantTextSummary: '已完成帮助文案调整并通过定向测试',
      },
    ];
    const md = renderReport(state);
    expect(md).toContain('111');
    expect(md).toContain('222');
    expect(md).toContain('333');
    expect(md).toContain('444');
    expect(md).toContain('调用可观测性明细');
    expect(md).toContain('Read');
    expect(md).toContain('permission_denials 数量：0');
    expect(md).toContain('已完成帮助文案调整并通过定向测试');
  });
});

describe('evaluateDirectEditEligibility：Direct Edit 命中条件（纯函数，不调用模型）', () => {
  const simpleZeroRisk = { complexity: 'simple' as const, riskScore: 0, reasons: [], touchesHighRisk: false };

  it('simple + riskScore 0 + 1~2 个显式文件 + 非高风险话题：合格', () => {
    const r = evaluateDirectEditEligibility(simpleZeroRisk, '优化 scripts/ccAuto/cli.ts 的一处帮助文案', DEFAULT_CONFIG);
    expect(r.eligible).toBe(true);
    expect(r.targetFiles).toEqual(['scripts/ccAuto/cli.ts']);
  });

  it('复杂度非 simple：不合格', () => {
    const r = evaluateDirectEditEligibility({ ...simpleZeroRisk, complexity: 'normal' }, '优化 a.ts', DEFAULT_CONFIG);
    expect(r.eligible).toBe(false);
  });

  it('riskScore 非 0：不合格', () => {
    const r = evaluateDirectEditEligibility({ ...simpleZeroRisk, riskScore: 2 }, '优化 a.ts', DEFAULT_CONFIG);
    expect(r.eligible).toBe(false);
  });

  it('无显式文件或超过 2 个文件：不合格', () => {
    expect(evaluateDirectEditEligibility(simpleZeroRisk, '修改按钮文案', DEFAULT_CONFIG).eligible).toBe(false);
    expect(evaluateDirectEditEligibility(simpleZeroRisk, '改 a.ts b.ts c.ts', DEFAULT_CONFIG).eligible).toBe(false);
  });

  it('涉及数据库/依赖/配置/Provider/SSE 等高风险话题：不合格', () => {
    expect(evaluateDirectEditEligibility(simpleZeroRisk, '改 a.ts 的 schema migration', DEFAULT_CONFIG).eligible).toBe(false);
    expect(evaluateDirectEditEligibility(simpleZeroRisk, '在 a.ts 新增一个依赖', DEFAULT_CONFIG).eligible).toBe(false);
    expect(evaluateDirectEditEligibility(simpleZeroRisk, '改 a.ts 的 SSE 逻辑', DEFAULT_CONFIG).eligible).toBe(false);
  });
});

describe('resolveExplicitFileReferences：文件路径规范化（读盘，纯函数不改文件）', () => {
  /** 在测试仓库里写入一个文件（含目录），供 basename 唯一定位。 */
  function touch(rel: string): void {
    const abs = path.join(cwd, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, '// x\n', 'utf8');
  }

  it('scripts/ccAuto/cli.ts + 裸 cli.ts → 只得到 scripts/ccAuto/cli.ts（同一文件，不重复计数）', () => {
    touch('scripts/ccAuto/cli.ts');
    const r = resolveExplicitFileReferences('优化 scripts/ccAuto/cli.ts，同步更新 cli.ts', cwd);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['scripts/ccAuto/cli.ts']);
  });

  it('scripts/ccAuto/cli.ts + 裸 cli.ts + 裸 cli.spec.ts（仓库唯一）→ 恰好两个真实文件', () => {
    touch('scripts/ccAuto/cli.ts');
    touch('scripts/ccAuto/cli.spec.ts');
    const r = resolveExplicitFileReferences('优化 scripts/ccAuto/cli.ts 与 cli.ts，并更新 cli.spec.ts', cwd);
    expect(r.ok).toBe(true);
    expect(new Set(r.files)).toEqual(new Set(['scripts/ccAuto/cli.ts', 'scripts/ccAuto/cli.spec.ts']));
    expect(r.files.length).toBe(2);
  });

  it('仓库中两个不同目录都有 cli.ts 时，单独的裸 cli.ts 不得被猜测解析（ok:false）', () => {
    touch('a/cli.ts');
    touch('b/cli.ts');
    const r = resolveExplicitFileReferences('优化 cli.ts 的一处文案', cwd);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cli.ts');
  });

  it('./scripts/ccAuto/cli.ts 与 scripts/ccAuto/cli.ts 归一去重为同一路径', () => {
    touch('scripts/ccAuto/cli.ts');
    const r = resolveExplicitFileReferences('优化 ./scripts/ccAuto/cli.ts 和 scripts/ccAuto/cli.ts', cwd);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(['scripts/ccAuto/cli.ts']);
  });

  it('.. 穿越原样透传（不规范化、不映射），且被仓库边界校验拒绝（绝对路径由 prepare 阶段用例覆盖）', () => {
    const r = resolveExplicitFileReferences('优化 ../outside.ts 的一处文案', cwd);
    expect(r.ok).toBe(true);
    expect(r.files).toContain('../outside.ts'); // 原样保留，未被规范化成仓库内路径
    // 穿越项无法通过仓库边界校验，prepare 阶段会安全拒绝。
    expect(r.files.every((f) => isPathWithinRepo(cwd, f))).toBe(false);
  });

  it('修复后的原真实回归任务能命中 Direct Edit eligibility（去重后恰为两个真实文件）', () => {
    touch('scripts/ccAuto/cli.ts');
    touch('scripts/ccAuto/cli.spec.ts');
    const task = '优化 scripts/ccAuto/cli.ts 中 report 子命令的一处帮助文案，使其明确表达：查看指定运行任务的模型调用、渠道费用和验证结果。同步更新对应测试。只允许修改 cli.ts 和对应的 cli.spec.ts，不得改变命令参数、状态机、预算逻辑或实际运行行为。';
    const simpleZeroRisk = { complexity: 'simple' as const, riskScore: 0, reasons: [], touchesHighRisk: false };
    const r = evaluateDirectEditEligibility(simpleZeroRisk, task, DEFAULT_CONFIG, cwd);
    expect(r.eligible).toBe(true);
    expect(new Set(r.targetFiles)).toEqual(new Set(['scripts/ccAuto/cli.ts', 'scripts/ccAuto/cli.spec.ts']));
  });
});

describe('isPathWithinRepo：路径安全校验', () => {
  it('仓库内相对路径通过', () => {
    expect(isPathWithinRepo(cwd, 'scripts/ccAuto/cli.ts')).toBe(true);
  });
  it('绝对路径被拒', () => {
    expect(isPathWithinRepo(cwd, path.resolve(cwd, 'a.ts'))).toBe(false);
    expect(isPathWithinRepo(cwd, '/etc/passwd')).toBe(false);
  });
  it('`..` 穿越被拒', () => {
    expect(isPathWithinRepo(cwd, '../outside.ts')).toBe(false);
    expect(isPathWithinRepo(cwd, 'scripts/../../outside.ts')).toBe(false);
  });
  it('仓库根目录本身不算可编辑文件', () => {
    expect(isPathWithinRepo(cwd, '.')).toBe(false);
  });
});

describe('prepareDirectEditContext：机器准备上下文（读盘 + 校验）', () => {
  it('目标外/穿越路径被拒，绝不读盘', () => {
    expect(prepareDirectEditContext(cwd, ['../outside.ts']).ok).toBe(false);
    expect(prepareDirectEditContext(cwd, [path.resolve(cwd, 'x.ts')]).ok).toBe(false);
  });

  it('目标文件不存在被拒', () => {
    expect(prepareDirectEditContext(cwd, ['nope/missing.ts']).ok).toBe(false);
  });

  it('超过单文件安全上限被拒', () => {
    writeFileSync(path.join(cwd, 'big.ts'), 'x'.repeat(64 * 1024 + 1), 'utf8');
    expect(prepareDirectEditContext(cwd, ['big.ts']).ok).toBe(false);
  });

  it('合规文件被读取', () => {
    writeFileSync(path.join(cwd, 'ok.ts'), 'export const a = 1;\n', 'utf8');
    const ctx = prepareDirectEditContext(cwd, ['ok.ts']);
    expect(ctx.ok).toBe(true);
    expect(ctx.files[0].content).toContain('export const a = 1;');
  });
});

describe('validateDirectEdits：edits 校验（零/多匹配、目标外、search==replace）', () => {
  const files: PreparedFile[] = [{ path: 'a.ts', content: 'const x = 1;\nconst y = 2;\n', bytes: 24 }];

  it('edits 为空被拒', () => {
    expect(validateDirectEdits([], files, DEFAULT_CONFIG).ok).toBe(false);
  });
  it('目标外文件被拒', () => {
    expect(validateDirectEdits([{ path: 'b.ts', search: 'x', replace: 'z' }], files, DEFAULT_CONFIG).ok).toBe(false);
  });
  it('search===replace 被拒', () => {
    expect(validateDirectEdits([{ path: 'a.ts', search: 'const x = 1;', replace: 'const x = 1;' }], files, DEFAULT_CONFIG).ok).toBe(false);
  });
  it('search 零匹配被拒', () => {
    expect(validateDirectEdits([{ path: 'a.ts', search: 'not-present', replace: 'z' }], files, DEFAULT_CONFIG).ok).toBe(false);
  });
  it('search 多匹配被拒（要求唯一）', () => {
    expect(validateDirectEdits([{ path: 'a.ts', search: 'const ', replace: 'let ' }], files, DEFAULT_CONFIG).ok).toBe(false);
  });
  it('唯一匹配通过', () => {
    expect(validateDirectEdits([{ path: 'a.ts', search: 'const x = 1;', replace: 'const x = 42;' }], files, DEFAULT_CONFIG).ok).toBe(true);
  });
});

describe('applyDirectEdits：原子应用（失败不部分写入）', () => {
  it('多 edit 全部有效时统一写入并产生真实内容变更', () => {
    writeFileSync(path.join(cwd, 'm.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
    const files = prepareDirectEditContext(cwd, ['m.ts']).files;
    const edits = [
      { path: 'm.ts', search: 'const x = 1;', replace: 'const x = 10;' },
      { path: 'm.ts', search: 'const y = 2;', replace: 'const y = 20;' },
    ];
    const r = applyDirectEdits(cwd, edits, files);
    expect(r.ok).toBe(true);
    const written = readFileSync(path.join(cwd, 'm.ts'), 'utf8');
    expect(written).toContain('const x = 10;');
    expect(written).toContain('const y = 20;');
  });

  it('某个 edit 在应用阶段无法匹配时整体失败，不产生部分修改', () => {
    const original = 'const x = 1;\nconst y = 2;\n';
    writeFileSync(path.join(cwd, 'p.ts'), original, 'utf8');
    const files = prepareDirectEditContext(cwd, ['p.ts']).files;
    // 第一条有效、第二条 search 不存在：整体失败，文件保持原样。
    const edits = [
      { path: 'p.ts', search: 'const x = 1;', replace: 'const x = 10;' },
      { path: 'p.ts', search: 'DOES-NOT-EXIST', replace: 'z' },
    ];
    const r = applyDirectEdits(cwd, edits, files);
    expect(r.ok).toBe(false);
    expect(readFileSync(path.join(cwd, 'p.ts'), 'utf8')).toBe(original); // 未部分写入
  });
});

describe('directEditPrompt：只包含任务、允许文件与文件内容，不含探索指令', () => {
  it('包含任务、文件路径与内容', () => {
    const files: PreparedFile[] = [{ path: 'a.ts', content: 'export const a = 1;', bytes: 20 }];
    const prompt = directEditPrompt('优化 a.ts', files);
    expect(prompt).toContain('优化 a.ts');
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('export const a = 1;');
  });
});

describe('renderReport：执行模式与可观测性缺失字段显式「不可用」', () => {
  function baseCall(overrides: Partial<CallUsage>): CallUsage {
    return {
      callId: 'test-call',
      model: 'builder', modelId: 'claude-sonnet-5',
      inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.01, costRmbOfficial: 0.07, costRmbCustom: 0.07, costRmb: 0.07,
      durationMs: 100, numTurns: 1, pricingStatus: 'PRICED',
      subtype: 'success', isError: false, permissionDenialsCount: 0,
      ...overrides,
    };
  }

  it('directEdit=true 且有明细时报告标注 Simple Direct Edit 并展示目标文件/edit数量/应用结果', () => {
    const state = createRunState(cwd, 'run-mode-direct', '优化 scripts/ccAuto/cli.ts 文案', 'custom');
    state.directEdit = true;
    state.directEditDetail = {
      targetFiles: ['scripts/ccAuto/cli.ts'], editCount: 2,
      appliedFiles: ['scripts/ccAuto/cli.ts'], summary: '调整两处帮助文案', suggestedTests: ['scripts/ccAuto/cli.spec.ts'],
    };
    const md = renderReport(state);
    expect(md).toContain('执行模式：Simple Direct Edit');
    expect(md).toContain('Simple Direct Edit 明细');
    expect(md).toContain('应用的 edit 数量：2');
    expect(md).toContain('scripts/ccAuto/cli.ts');
    expect(md).toContain('调整两处帮助文案');
  });

  it('directEdit=false/未设置时报告标注标准执行模式，且不出现 Direct Edit 明细', () => {
    const state = createRunState(cwd, 'run-mode-standard', '重构整体架构', 'custom');
    const md = renderReport(state);
    expect(md).toContain('执行模式：标准');
    expect(md).not.toContain('Simple Direct Edit 明细');
  });

  it('CLI 未回传可观测字段的调用：不再整段跳过，且缺失字段显式标注「不可用」', () => {
    const state = createRunState(cwd, 'run-obs-missing', '演示任务', 'custom');
    // 全字段缺失（CLI 未回传 conversation）：旧实现会整段跳过，新实现必须列出并标「不可用」。
    state.calls = [baseCall({ model: 'scout', modelId: 'claude-haiku-4-5' })];
    const md = renderReport(state);
    expect(md).toContain('调用可观测性明细');
    expect(md).toContain('scout（claude-haiku-4-5');
    expect(md).toContain('不可用（CLI 未返回该字段）');
    // permission_denials 恒由 CLI 直接回传，即使为 0 也是真实值，不标「不可用」。
    expect(md).toContain('permission_denials 数量：0');
    // 缺失字段不得再退化成「（无记录）/（无）」这类会掩盖可观测缺口的措辞。
    expect(md).not.toContain('（无记录）');
  });

  it('mcpServers 为空数组（已隔离，真实为空）与 undefined（CLI 未返回）区分展示', () => {
    const state = createRunState(cwd, 'run-obs-mcp', '演示任务', 'custom');
    state.calls = [
      baseCall({ mcpServers: [] }),
      baseCall({ model: 'scout', modelId: 'claude-haiku-4-5' }),
    ];
    const md = renderReport(state);
    expect(md).toContain('MCP server：（无，已隔离）');
    expect(md).toContain(`MCP server：不可用（CLI 未返回该字段）`);
  });
});

describe('runDirectEdit 端到端：真实执行路径（不调用真实模型）', () => {
  /** 在测试 git 仓库里写入并提交一个文件，使 changedFilesSince 能检出后续真实 diff。 */
  function commitFile(rel: string, content: string): void {
    const abs = path.join(cwd, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd });
  }

  function directEditResult(edits: unknown, summary = 'ok'): ClaudeCallResult {
    return { raw: {}, resultText: '', structuredOutput: { edits, summary, suggestedTests: ['x.spec.ts'] }, isError: false, subtype: 'success', usage: usage('builder'), permissionDenials: [] };
  }

  it('合格任务真实进入 Direct Edit：tools 为空、maxTurns<=2、应用后产生真实 diff 并标记 directEdit', async () => {
    commitFile('note.ts', 'export const label = "旧文案";\n');
    let capturedTools: string[] | undefined;
    let capturedMaxTurns: number | undefined;
    let scoutCalled = false;
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'scout') { scoutCalled = true; return fakeResult('scout', { relevantFiles: [] }); }
        capturedTools = options.tools;
        capturedMaxTurns = options.rule.maxTurns;
        return directEditResult([{ path: 'note.ts', search: '旧文案', replace: '新文案' }]);
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 note.ts 的一处文案');
    expect(scoutCalled).toBe(false); // simple 任务不加 Scout
    expect(capturedTools).toEqual([]); // Direct Edit Builder 无任何文件工具
    expect(capturedMaxTurns).toBeLessThanOrEqual(2);
    expect(state.directEdit).toBe(true);
    expect(state.directEditDetail?.editCount).toBe(1);
    expect(state.currentPhase).toBe('DONE');
    expect(readFileSync(path.join(cwd, 'note.ts'), 'utf8')).toContain('新文案');
  });

  it('不合格任务（无显式文件）回退标准 Agent Builder 路径，不标记 directEdit', async () => {
    let sawBuilderTools: string[] | undefined;
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        sawBuilderTools = options.tools;
        return fakeResult('builder', { summary: 'ok', changedFiles: ['a.ts'], needsArbitration: false });
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '修改按钮文案'); // 无显式文件 -> 不合格
    expect(state.directEdit).toBeFalsy();
    expect(sawBuilderTools).toContain('Edit'); // 走的是标准 Agent Builder（有文件工具）
  });

  it('search 多匹配导致校验失败：STOPPED(DIRECT_EDIT_APPLY_FAILED)，不写盘', async () => {
    const original = 'const a = 1;\nconst b = 2;\n';
    commitFile('multi.ts', original);
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'scout') return fakeResult('scout', { relevantFiles: [] });
        return directEditResult([{ path: 'multi.ts', search: 'const ', replace: 'let ' }]); // 多匹配
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 multi.ts 的一处写法');
    expect(state.currentPhase).toBe('STOPPED');
    expect(state.stopReason).toBe('DIRECT_EDIT_APPLY_FAILED');
    expect(state.directEdit).toBeFalsy(); // 未成功执行，不得伪装
    expect(readFileSync(path.join(cwd, 'multi.ts'), 'utf8')).toBe(original); // 未写盘
  });

  it('edits 为空导致校验失败：STOPPED(DIRECT_EDIT_APPLY_FAILED)', async () => {
    commitFile('empty.ts', 'export const z = 0;\n');
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'scout') return fakeResult('scout', { relevantFiles: [] });
        return directEditResult([]); // 空 edits
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 empty.ts 的一处逻辑');
    expect(state.currentPhase).toBe('STOPPED');
    expect(state.stopReason).toBe('DIRECT_EDIT_APPLY_FAILED');
  });

  it('报告只在真实执行 Direct Edit 时标记；应用失败的运行报告显示标准路径', async () => {
    commitFile('fail.ts', 'const p = 1;\nconst q = 1;\n');
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'scout') return fakeResult('scout', { relevantFiles: [] });
        return directEditResult([{ path: 'fail.ts', search: 'const ', replace: 'let ' }]); // 多匹配 -> 失败
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 fail.ts 的一处写法');
    const md = renderReport(state);
    expect(md).toContain('执行模式：标准');
    expect(md).not.toContain('Simple Direct Edit 明细');
    expect(md).toContain('DIRECT_EDIT_APPLY_FAILED');
  });

  it('候选任务路径穿越：STOPPED(DIRECT_EDIT_PREPARE_FAILED)，不调用任何标准 Builder', async () => {
    let builderCalled = false;
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        // 准备阶段应在任何模型调用之前就安全拒绝：这里若被调用即视为绕过安全边界。
        builderCalled = true;
        if (options.role === 'scout') return fakeResult('scout', { relevantFiles: [] });
        return directEditResult([{ path: '../outside.ts', search: 'a', replace: 'b' }]);
      },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 ../outside.ts 的一处文案');
    expect(state.currentPhase).toBe('STOPPED');
    expect(state.stopReason).toBe('DIRECT_EDIT_PREPARE_FAILED');
    expect(builderCalled).toBe(false); // 准备失败绝不落入拥有 Read/Edit/Bash 的标准 Builder
    expect(state.directEdit).toBeFalsy();
  });

  it('候选文件不存在：STOPPED(DIRECT_EDIT_PREPARE_FAILED)，不调用标准 Builder', async () => {
    let builderCalled = false;
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (): Promise<ClaudeCallResult> => { builderCalled = true; return fakeResult('builder', { summary: 'x', changedFiles: [], needsArbitration: false }); },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 nope-missing.ts 的一处文案');
    expect(state.currentPhase).toBe('STOPPED');
    expect(state.stopReason).toBe('DIRECT_EDIT_PREPARE_FAILED');
    expect(builderCalled).toBe(false);
  });

  it('候选文件超过安全上限：STOPPED(DIRECT_EDIT_PREPARE_FAILED)，不调用标准 Builder', async () => {
    // 建一个存在但超过 64KB 的目标文件：eligibility 通过（simple/risk0/1文件），prepare 因超限安全拒绝。
    writeFileSync(path.join(cwd, 'huge.ts'), `// ${'x'.repeat(64 * 1024 + 10)}\n`, 'utf8');
    let builderCalled = false;
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (): Promise<ClaudeCallResult> => { builderCalled = true; return fakeResult('builder', { summary: 'x', changedFiles: [], needsArbitration: false }); },
      runTests: async () => ({ passed: true, output: 'ok' }),
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 huge.ts 的一处文案');
    expect(state.currentPhase).toBe('STOPPED');
    expect(state.stopReason).toBe('DIRECT_EDIT_PREPARE_FAILED');
    expect(builderCalled).toBe(false);
  });

  it('恶意 suggestedTests 不会被执行：只作为报告数据，VERIFY 仍用机器侧受控命令', async () => {
    commitFile('safe.ts', 'export const greeting = "hi";\n');
    const runTestsTargets: string[][] = [];
    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'scout') return fakeResult('scout', { relevantFiles: [] });
        // 模型返回一个「像 shell 注入」的 suggestedTests：绝不能被当作命令执行。
        return {
          raw: {}, resultText: '',
          structuredOutput: {
            edits: [{ path: 'safe.ts', search: '"hi"', replace: '"hello"' }],
            summary: '调整问候语',
            suggestedTests: ['x.spec.ts; rm -rf /', '$(touch /tmp/pwned)'],
          },
          isError: false, subtype: 'success', usage: usage('builder'), permissionDenials: [],
        };
      },
      // 机器侧受控测试选择：只接收改动文件，绝不接收 suggestedTests。
      runTests: async (files: string[]) => { runTestsTargets.push(files); return { passed: true, output: 'ok' }; },
      runFullVerification: async () => ({ passed: true, output: 'full ok' }),
      currentDailyRmb: () => 0, recordDailySpend: () => {}, hookSettingsInlineJson: '{}', log: () => {},
    };
    const state = await runTask(deps, '优化 safe.ts 的一处文案');
    expect(state.currentPhase).toBe('DONE');
    expect(state.directEdit).toBe(true);
    // runTests 收到的目标里绝不含 suggestedTests 的任何注入字符串。
    const allTargets = runTestsTargets.flat();
    expect(allTargets.some((t) => t.includes('rm -rf') || t.includes('$(') || t.includes(';'))).toBe(false);
    // suggestedTests 原样保留在报告数据中（仅作建议展示，不参与执行）。
    expect(state.directEditDetail?.suggestedTests).toContain('x.spec.ts; rm -rf /');
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1 Production Chain: Direct Edit FINAL_VERIFY Skip
  // ─────────────────────────────────────────────────────────────────────
  it('生产链：机械 demoRun.ts Direct Edit 成功 → VERIFY 通过 → 跳过 FINAL_VERIFY → 直接 DONE（不跑全仓/全 cc-auto suite）', async () => {
    // 仿 demoRun.ts 内容：一个包含标题文案的 fixture
    const fixtureContent = 'export const TITLE = "演示标题";\n';
    const fixtureDir = path.join(cwd, 'scripts', 'ccAuto', '__fixtures__');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(path.join(fixtureDir, 'demoRun.ts'), fixtureContent, 'utf8');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd });

    let runFullVerificationCalls = 0;
    let runTestsFiles: string[][] = [];
    let builderCalled = false;

    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'builder') {
          builderCalled = true;
          // Direct Edit Builder: no tools, search/replace on demoRun.ts only
          expect(options.tools).toEqual([]);
          expect(options.rule.model).toBe('claude-sonnet-5');
          return {
            raw: {}, resultText: '', isError: false, subtype: 'success',
            structuredOutput: {
              edits: [{ path: 'scripts/ccAuto/__fixtures__/demoRun.ts', search: '演示标题', replace: '演示标题 [cc-auto smoke test]' }],
              summary: '在 demoRun.ts 标题末尾加 cc-auto smoke test 后缀',
              suggestedTests: [],
            },
            usage: usage('builder'),
            permissionDenials: [],
          };
        }
        // Scout 不该被调用（simple → IMPLEMENT 跳过 SCOUT）
        return fakeResult('scout', { relevantFiles: [] });
      },
      runTests: async (files: string[]) => {
        runTestsFiles.push(files);
        return { passed: true, output: 'typecheck 通过' };
      },
      runFullVerification: async () => {
        runFullVerificationCalls += 1;
        return { passed: true, output: 'full ok' };
      },
      currentDailyRmb: () => 0,
      recordDailySpend: () => {},
      hookSettingsInlineJson: '{}',
      log: () => {},
    };

    const state = await runTask(
      deps,
      '在 scripts/ccAuto/__fixtures__/demoRun.ts 中，把现有 demo 标题文案末尾加上 \' [cc-auto smoke test]\'，只允许修改这个文件，不改任何逻辑，不新增文件。',
    );

    // --- 核心断言 ---
    // 1. Direct Edit 执行成功
    expect(state.directEdit).toBe(true);
    expect(state.currentPhase).toBe('DONE');
    expect(state.done).toBe(true);
    expect(state.stopReason).toBeUndefined();
    if (state.stopReason) console.error(`STOP_REASON: ${state.stopReason} — ${state.stopDetail}`);

    // 2. changedFiles 只有 demoRun.ts
    expect(state.changedFiles.length).toBe(1);
    expect(state.changedFiles[0]).toMatch(/demoRun\.ts$/);

    // 3. runFullVerification 调用次数 = 0
    expect(runFullVerificationCalls).toBe(0);

    // 4. runTests 被调用一次（VERIFY 阶段），传入的只有 demoRun.ts，不含任何无关 ccAuto fixture
    expect(runTestsFiles.length).toBe(1);
    expect(runTestsFiles[0].length).toBe(1);
    expect(runTestsFiles[0][0]).toMatch(/demoRun\.ts$/);
    // 确认没有任何无关 ccAuto fixture 文件被传入 runTests
    for (const f of runTestsFiles.flat()) {
      expect(f).not.toMatch(/multi\.ts|note\.ts|safe\.ts|empty\.ts|fail\.ts/);
    }

    // 5. Builder 被调用（Direct Edit Builder）
    expect(builderCalled).toBe(true);

    // 6. 落地内容验证
    const writtenContent = readFileSync(path.join(fixtureDir, 'demoRun.ts'), 'utf8');
    expect(writtenContent).toContain('[cc-auto smoke test]');
    expect(writtenContent).toContain('演示标题');
  });

  // ─────────────────────────────────────────────────────────────────────
  // P1 Regression: Dirty Worktree Isolation
  // 回归：VERIFY 不得把预存脏文件当作 Direct Edit 的测试目标
  // ─────────────────────────────────────────────────────────────────────
  it('脏工作区回归：预存 dirty files（cli.ts/orchestrator.ts/orchestrator.spec.ts）不被纳入 Direct Edit VERIFY 测试目标', async () => {
    // 1. 构造预存已提交文件，然后在 Direct Edit 前制造 dirty 改动
    const fixtureDir = path.join(cwd, 'scripts', 'ccAuto', '__fixtures__');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(path.join(fixtureDir, 'demoRun.ts'), 'export const TITLE = "演示标题";\n', 'utf8');
    writeFileSync(path.join(cwd, 'scripts', 'ccAuto', 'cli.ts'), '// dirty pre-existing\n', 'utf8');
    writeFileSync(path.join(cwd, 'scripts', 'ccAuto', 'orchestrator.ts'), '// dirty pre-existing\n', 'utf8');
    writeFileSync(path.join(cwd, 'scripts', 'ccAuto', 'orchestrator.spec.ts'), '// dirty pre-existing\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd });

    // 2. 修改 3 个文件使其变 dirty（在工作区内「预存未提交改动」）
    //    但 demoRun.ts 保持 clean —— Direct Edit 会修改它
    const dirtyFiles = [
      'scripts/ccAuto/cli.ts',
      'scripts/ccAuto/orchestrator.ts',
      'scripts/ccAuto/orchestrator.spec.ts',
    ];
    for (const rel of dirtyFiles) {
      writeFileSync(path.join(cwd, rel), `// dirty pre-existing modification at ${Date.now()}\n`, 'utf8');
    }

    // 3. 确认 changedFilesSince 确实看到了这 3 个预存 dirty files
    const dirtyBefore = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const rel of dirtyFiles) {
      expect(dirtyBefore).toContain(rel);
    }

    let runFullVerificationCalls = 0;
    let runTestsFiles: string[][] = [];
    let builderCalled = false;

    const deps = {
      cwd, config: DEFAULT_CONFIG,
      runClaude: async (options: ClaudeCallOptions): Promise<ClaudeCallResult> => {
        if (options.role === 'builder') {
          builderCalled = true;
          expect(options.tools).toEqual([]);
          expect(options.rule.model).toBe('claude-sonnet-5');
          return {
            raw: {}, resultText: '', isError: false, subtype: 'success',
            structuredOutput: {
              edits: [{ path: 'scripts/ccAuto/__fixtures__/demoRun.ts', search: '演示标题', replace: '演示标题 [cc-auto smoke test]' }],
              summary: '在 demoRun.ts 标题末尾加后缀',
              suggestedTests: [],
            },
            usage: usage('builder'),
            permissionDenials: [],
          };
        }
        return fakeResult('scout', { relevantFiles: [] });
      },
      runTests: async (files: string[]) => {
        runTestsFiles.push(files);
        return { passed: true, output: 'typecheck 通过' };
      },
      runFullVerification: async () => {
        runFullVerificationCalls += 1;
        return { passed: true, output: 'full ok' };
      },
      currentDailyRmb: () => 0,
      recordDailySpend: () => {},
      hookSettingsInlineJson: '{}',
      log: () => {},
    };

    const state = await runTask(
      deps,
      '在 scripts/ccAuto/__fixtures__/demoRun.ts 中，把现有 demo 标题文案末尾加上 \' [cc-auto smoke test]\'，只允许修改这个文件，不改任何逻辑，不新增文件。',
    );

    // --- 精确断言 ---

    // A. Direct Edit 成功
    expect(state.directEdit).toBe(true);
    expect(state.currentPhase).toBe('DONE');
    expect(state.done).toBe(true);
    expect(state.stopReason).toBeUndefined();

    // B. changedFiles 只有 demoRun.ts（不含预存 dirty files）
    expect(state.changedFiles.length).toBe(1);
    expect(state.changedFiles[0]).toEqual('scripts/ccAuto/__fixtures__/demoRun.ts');

    // C. runFullVerification 调用 0 次
    expect(runFullVerificationCalls).toBe(0);

    // D. runTests 调用 1 次
    expect(runTestsFiles.length).toBe(1);

    // E. runTests 收到的 files 精确等于 [demoRun.ts]，不含任何预存 dirty file
    expect(runTestsFiles[0].length).toBe(1);
    expect(runTestsFiles[0][0]).toEqual('scripts/ccAuto/__fixtures__/demoRun.ts');

    // F. 显式断言不包含 3 个预存 dirty files
    const allTargets = runTestsFiles.flat();
    expect(allTargets).not.toContain('scripts/ccAuto/cli.ts');
    expect(allTargets).not.toContain('scripts/ccAuto/orchestrator.ts');
    expect(allTargets).not.toContain('scripts/ccAuto/orchestrator.spec.ts');

    // G. 确认预存 dirty files 仍然 dirty（Direct Edit 没有误改它们）
    const dirtyAfter = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const rel of dirtyFiles) {
      expect(dirtyAfter).toContain(rel);
    }

    // H. Builder 被调用
    expect(builderCalled).toBe(true);
  });
});
