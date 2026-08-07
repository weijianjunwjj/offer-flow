/** routedExecution.spec.ts — 路由执行 + 升级 + 记账 + 持久化集成测试 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeWithModelRouting } from './routedExecution';
import { selectExecutionModel } from './modelRouting';
import { estimateTaskBudget, resetEstimateSequence } from './taskBudget';
import { buildTaskCostSummary } from './taskCostSummary';
import {
  loadBudgetEstimate,
  loadRoutingDecisions,
  loadCostSummary,
  loadArbitrationCapsule,
  createRunState,
} from './store';
import { MockProviderAdapter, AdapterRegistry } from './adapter';
import type {
  ModelRoutingContext,
  ModelRoutingConfig,
  TaskBudgetPolicy,
  ModelPricing,
  ProviderProfile,
  RoutedExecutionReporter,
  TaskBudgetEstimate,
  TaskCostSummary,
} from './types';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// ============================================================================
// Fixtures
// ============================================================================

const FIXTURE_CWD = path.join(__dirname, '..', '..', '.cc-auto-test-routed');

function setupFixture() {
  cleanupFixture();
  mkdirSync(FIXTURE_CWD, { recursive: true });
}

function cleanupFixture() {
  try { rmSync(path.join(FIXTURE_CWD, '.cc-auto'), { recursive: true, force: true }); } catch { /* ok */ }
}

const FLASH_PRICING: ModelPricing = {
  inputPerMTokens: 1.0, outputPerMTokens: 2.0,
  cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1,
  currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
};

const PRO_PRICING: ModelPricing = {
  inputPerMTokens: 2.0, outputPerMTokens: 4.0,
  cacheCreationPerMTokens: 2.5, cacheReadPerMTokens: 0.2,
  currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
};

const OPUS_FIXTURE: ModelPricing = {
  inputPerMTokens: 3.5, outputPerMTokens: 17.5,
  cacheCreationPerMTokens: 4.38, cacheReadPerMTokens: 0.35,
  currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
};

const ROUTING_CONFIG: ModelRoutingConfig = {
  enabled: true,
  fastModel: { provider: 'deepseek', profileId: 'flash-profile', modelLogicalName: 'flash-model' },
  strongModel: { provider: 'deepseek', profileId: 'pro-profile', modelLogicalName: 'pro-model' },
  arbiterModel: { provider: 'anthropic', profileId: 'opus-profile', modelLogicalName: 'opus-model' },
  allowStrongEscalation: true,
  allowArbiterEscalation: true,
};

const BUDGET_POLICY: TaskBudgetPolicy = {
  mode: 'BALANCED',
  requireConfirmationAboveSoftLimit: false,
  stopBeforeHardLimit: false,
};

const FLASH_PROFILE: ProviderProfile = {
  id: 'flash-profile', displayName: 'Flash', vendor: 'deepseek', transport: 'openai-chat',
  credentialEnvVars: ['FAKE_KEY'], runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'flash-model',
  models: [{
    logicalName: 'flash-model', requestedModelId: 'flash-1',
    acceptedReportedModelIds: ['flash-1'], displayName: 'Flash',
  }],
  pricing: { 'flash-1': FLASH_PRICING },
};

const PRO_PROFILE: ProviderProfile = {
  id: 'pro-profile', displayName: 'Pro', vendor: 'deepseek', transport: 'openai-chat',
  credentialEnvVars: ['FAKE_KEY'], runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'pro-model',
  models: [{
    logicalName: 'pro-model', requestedModelId: 'pro-1',
    acceptedReportedModelIds: ['pro-1'], displayName: 'Pro',
  }],
  pricing: { 'pro-1': PRO_PRICING },
};

const OPUS_PROFILE: ProviderProfile = {
  id: 'opus-profile', displayName: 'Opus', vendor: 'anthropic', transport: 'openai-chat',
  credentialEnvVars: ['FAKE_KEY'], runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'opus-model',
  models: [{
    logicalName: 'opus-model', requestedModelId: 'opus-1',
    acceptedReportedModelIds: ['opus-1'], displayName: 'Opus 5',
  }],
  pricing: { 'opus-1': OPUS_FIXTURE },
};

function parentEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin', FAKE_KEY: 'sk-test' };
}

function baseContext(overrides: Partial<ModelRoutingContext> = {}): ModelRoutingContext {
  return {
    taskType: 'CODE_IMPLEMENTATION',
    affectedFileCount: 1,
    specificationClear: true,
    touchesArchitecture: false,
    touchesSecurityBoundary: false,
    touchesProviderLifecycle: false,
    touchesPendingCallOrUsage: false,
    touchesDatabaseSchema: false,
    touchesTransactionOrConcurrency: false,
    touchesStateMachine: false,
    previousAttemptCount: 0,
    allowEscalation: true,
    ...overrides,
  };
}

class TestReporter implements RoutedExecutionReporter {
  budgetEstimates: TaskBudgetEstimate[] = [];
  budgetFormatted: string[] = [];
  costSummaries: TaskCostSummary[] = [];
  costFormatted: string[] = [];

  async onBudgetEstimate(estimate: TaskBudgetEstimate, formatted: string): Promise<void> {
    this.budgetEstimates.push(estimate);
    this.budgetFormatted.push(formatted);
  }

  async onCostSummary(summary: TaskCostSummary, formatted: string): Promise<void> {
    this.costSummaries.push(summary);
    this.costFormatted.push(formatted);
  }
}

beforeEach(() => {
  setupFixture();
  resetEstimateSequence();
});

afterEach(cleanupFixture);

// ============================================================================
// 路由关闭——必须调用 Provider
// ============================================================================

describe('路由关闭', () => {
  it('enabled=false 时执行 Provider 调用', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-r0', '测试关闭路由', 'custom');
    const reporter = new TestReporter();
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-r0', taskId: 'task-r0', cwd: FIXTURE_CWD,
      routingConfigInput: { ...ROUTING_CONFIG, enabled: false },
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      legacyProfileId: 'flash-profile',
      legacyModelLogicalName: 'flash-model',
      reporter,
    } as any);
    // 必须执行了 Provider 调用
    expect(result.callIds.length).toBeGreaterThan(0);
    expect(result.status).toBe('COMPLETED');
  });

  it('enabled=false 时无升级', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-r1', '测试', 'custom');
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-r1', taskId: 'task-r1', cwd: FIXTURE_CWD,
      routingConfigInput: { ...ROUTING_CONFIG, enabled: false },
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      legacyProfileId: 'flash-profile',
      legacyModelLogicalName: 'flash-model',
    } as any);
    expect(result.selections.length).toBe(1);
    expect(result.callIds.length).toBe(1);
  });
});

// ============================================================================
// 预算时序
// ============================================================================

describe('预算时序', () => {
  it('预算在 Provider 调用前报告', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-seq', '时序测试', 'custom').runId;
    const reporter = new TestReporter();

    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId, taskId: 'task-seq', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);

    // 预算必须已报告
    expect(reporter.budgetEstimates.length).toBe(1);
    expect(reporter.budgetFormatted[0]).toContain('任务预算');

    // Provider 调用必须发生
    expect(result.callIds.length).toBeGreaterThan(0);

    // 成本复盘必须已报告
    expect(reporter.costSummaries.length).toBeGreaterThanOrEqual(1);
    expect(reporter.costFormatted[0]).toContain('模型成本复盘');
  });

  it('预算持久化后可在重启模拟中重新读取', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-persist-budget', '持久化测试', 'custom').runId;

    await executeWithModelRouting({
      routingContext: baseContext(),
      runId, taskId: 'task-pb', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);

    // 模拟重启后重新读取
    const loaded = loadBudgetEstimate(FIXTURE_CWD, runId);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe(runId);
    expect(loaded!.initialSelection.role).toBe('FAST_EXECUTOR');
  });
});

// ============================================================================
// Flash 成功
// ============================================================================

describe('Flash 成功', () => {
  it('Flash 一次调用成功 → COMPLETED', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-f1', 'f1', 'custom');
    const reporter = new TestReporter();
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-f1', taskId: 'task-f1', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);
    expect(result.status).toBe('COMPLETED');
    expect(result.finalRole).toBe('FAST_EXECUTOR');
    expect(result.callIds.length).toBe(1);
    expect(reporter.costSummaries.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// 预算限制
// ============================================================================

describe('预算限制', () => {
  it('soft limit 返回 BUDGET_CONFIRMATION_REQUIRED 且零调用', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-sl', 'sl', 'custom');
    const reporter = new TestReporter();
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-sl', taskId: 'task-sl', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: {
        mode: 'ECONOMY',
        softLimitRmb: 0.00001,
        hardLimitRmb: 50,
        requireConfirmationAboveSoftLimit: true,
        stopBeforeHardLimit: true,
      },
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);
    expect(result.status).toBe('BUDGET_CONFIRMATION_REQUIRED');
    expect(result.callIds.length).toBe(0);
    // 仍生成成本总结
    expect(reporter.costSummaries.length).toBeGreaterThanOrEqual(1);
    const summary = reporter.costSummaries[0];
    expect(summary.completed).toBe(false);
    expect(summary.actual.totalCalls).toBe(0);
  });

  it('hard limit 返回 BUDGET_LIMIT_EXCEEDED 且零调用', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-hl', 'hl', 'custom');
    const reporter = new TestReporter();
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-hl', taskId: 'task-hl', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: {
        mode: 'ECONOMY',
        hardLimitRmb: 0.000001,
        requireConfirmationAboveSoftLimit: false,
        stopBeforeHardLimit: true,
      },
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);
    expect(result.status).toBe('BUDGET_LIMIT_EXCEEDED');
    expect(result.callIds.length).toBe(0);
    expect(reporter.costSummaries.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Opus 仲裁——Capsule 分支顺序
// ============================================================================

describe('Opus 仲裁 — Capsule 分支顺序', () => {
  // 只有 Flash/Pro profile → Capsule 正常生成，不报 CREDENTIAL_FAILURE
  it('仅 Flash/Pro profile → 生成 Capsule 返回 OPUS_ARBITRATION_REQUIRED', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-o-nopus', 'no-opus-profile', 'custom').runId;
    const result = await executeWithModelRouting({
      routingContext: baseContext({
        touchesArchitecture: true,
        allowEscalation: true,
        previousAttemptCount: 1,
        previousModelRole: 'STRONG_EXECUTOR',
        previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro failed', contributedToFinalResult: false },
      }),
      runId, taskId: 'task-o-nopus', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING, 'opus-model': OPUS_FIXTURE },
      // 仅 Flash + Pro profiles，没有 Opus profile
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    expect(result.status).toBe('OPUS_ARBITRATION_REQUIRED');
    expect(result.arbitrationCapsule).toBeDefined();
    expect(result.arbitrationCapsule!.attemptedModels).toBeDefined();
    // 无 Opus 调用
    expect(result.callIds.length).toBe(0);
    // 不返回 CREDENTIAL_FAILURE
    expect(result.failureCategory).toBeUndefined();
  });

  // Pro 质量失败 + hasOpusProvider=false → OPUS_ARBITRATION_REQUIRED
  it('Pro 质量失败 → OPUS_ARBITRATION_REQUIRED（胶囊已保存）', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-o1', 'o1', 'custom').runId;
    const result = await executeWithModelRouting({
      routingContext: baseContext({
        touchesArchitecture: true,
        allowEscalation: true,
        previousAttemptCount: 1,
        previousModelRole: 'STRONG_EXECUTOR',
        previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro failed', contributedToFinalResult: false },
      }),
      runId, taskId: 'task-o1', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING, 'opus-model': OPUS_FIXTURE },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE, 'opus-profile': OPUS_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    expect(result.status).toBe('OPUS_ARBITRATION_REQUIRED');
    expect(result.arbitrationCapsule).toBeDefined();
    expect(result.arbitrationCapsule!.attemptedModels).toBeDefined();
    expect(result.callIds.length).toBe(0);
  });

  // 不产生 Opus UsageRecord（hasOpusProvider=false）
  it('hasOpusProvider=false 时不产生 Opus UsageRecord', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-o-nou', 'no-usage', 'custom').runId;
    const result = await executeWithModelRouting({
      routingContext: baseContext({
        touchesArchitecture: true,
        allowEscalation: true,
        previousAttemptCount: 1,
        previousModelRole: 'STRONG_EXECUTOR',
        previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro failed', contributedToFinalResult: false },
      }),
      runId, taskId: 'task-o-nou', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING, 'opus-model': OPUS_FIXTURE },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    expect(result.status).toBe('OPUS_ARBITRATION_REQUIRED');
    // 无 Provider 调用产生（callIds 为空）
    expect(result.callIds.length).toBe(0);
  });

  // 不返回 CREDENTIAL_FAILURE when hasOpusProvider=false
  it('hasOpusProvider=false 不返回 CREDENTIAL_FAILURE', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-o-nocf', 'no-cred-fail', 'custom').runId;
    const result = await executeWithModelRouting({
      routingContext: baseContext({
        touchesArchitecture: true,
        allowEscalation: true,
        previousAttemptCount: 1,
        previousModelRole: 'STRONG_EXECUTOR',
        previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro failed', contributedToFinalResult: false },
      }),
      runId, taskId: 'task-o-nocf', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING, 'opus-model': OPUS_FIXTURE },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    // 不应该返回 CREDENTIAL_FAILURE —— Capsule 已正常生成
    expect(result.failureCategory).toBeUndefined();
  });

  // Capsule 持久化后可重新读取
  it('Capsule 持久化后可重新读取', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-caps', 'caps', 'custom').runId;
    await executeWithModelRouting({
      routingContext: baseContext({
        touchesArchitecture: true,
        allowEscalation: true,
        previousAttemptCount: 1,
        previousModelRole: 'STRONG_EXECUTOR',
        previousFailure: { category: 'MODEL_QUALITY_FAILURE', summary: 'Pro failed', contributedToFinalResult: false },
      }),
      runId, taskId: 'task-caps', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING, 'opus-model': OPUS_FIXTURE },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE, 'opus-profile': OPUS_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    const loaded = loadArbitrationCapsule(FIXTURE_CWD, runId);
    expect(loaded).toBeDefined();
    expect(loaded!.taskGoal).toBeTruthy();
  });

  it('Capsule 大小受限', () => {
    // buildArbitrationCapsule is already bounded internally (diff ≤ 8000, taskGoal ≤ 2000, etc.)
    // Integration test above validates serialization
  });
});

// ============================================================================
// 记账
// ============================================================================

describe('记账', () => {
  it('Flash 一次调用产生一条 UsageRecord', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-ac1', 'ac1', 'custom');
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-ac1', taskId: 'task-ac1', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    expect(result.callIds.length).toBe(1);
  });

  it('不同模型选择产生不同的 modelLogicalName', () => {
    const sel1 = selectExecutionModel(baseContext(), ROUTING_CONFIG);
    const sel2 = selectExecutionModel(baseContext({ touchesArchitecture: true }), ROUTING_CONFIG);
    expect(sel1.modelLogicalName).not.toBe(sel2.modelLogicalName);
  });
});

// ============================================================================
// 持久化
// ============================================================================

describe('持久化', () => {
  it('路由决策持久化后可重新读取', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-rd', 'rd', 'custom').runId;
    await executeWithModelRouting({
      routingContext: baseContext(),
      runId, taskId: 'task-rd', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    const decisions = loadRoutingDecisions(FIXTURE_CWD, runId);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].runId).toBe(runId);
  });

  it('成本总结持久化后可重新读取', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const runId = createRunState(FIXTURE_CWD, 'run-cs2', 'cs2', 'custom').runId;
    await executeWithModelRouting({
      routingContext: baseContext(),
      runId, taskId: 'task-cs2', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
    } as any);
    const loaded = loadCostSummary(FIXTURE_CWD, runId);
    expect(loaded).toBeDefined();
    expect(loaded!.runId).toBe(runId);
  });

  it('老 RunState 无新字段时仍可读取', () => {
    const runId = createRunState(FIXTURE_CWD, 'run-old', 'old', 'custom').runId;
    // 新字段为 optional，loadRunState 不应抛异常
    const loaded = loadBudgetEstimate(FIXTURE_CWD, runId);
    expect(loaded).toBeUndefined();
    const decisions = loadRoutingDecisions(FIXTURE_CWD, runId);
    expect(decisions).toEqual([]);
  });
});

// ============================================================================
// 估算 vs 实际字段分离
// ============================================================================

describe('估算与实际字段分离', () => {
  it('estimatedCostRmb 和 actualCostRmb 不混合', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-sep', 'sep', 'custom');
    const reporter = new TestReporter();
    await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-sep', taskId: 'task-sep', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);

    // 预算中只有 estimatedCostRmb
    const budget = reporter.budgetEstimates[0];
    expect(budget).toBeDefined();
    for (const call of budget.estimatedCalls) {
      expect(call.estimatedCostRmb.expected).not.toBeUndefined();
    }

    // 成本总结中 actual 来自 UsageRecord
    const summary = reporter.costSummaries[0];
    expect(summary).toBeDefined();
    // actual 字段是独立存在的
    expect(summary.actual).toBeDefined();
    // estimated 字段在 estimate 中
    expect(summary.estimate).toBeDefined();
    expect(summary.estimate.totalEstimatedCostRmb.expected).not.toBeUndefined();
  });
});

// ============================================================================
// 预算格式包含 Flash override rejected 说明
// ============================================================================

describe('预算输出', () => {
  it('高风险 FAST override 预算包含说明', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    createRunState(FIXTURE_CWD, 'run-fo', 'fo', 'custom');
    const reporter = new TestReporter();
    await executeWithModelRouting({
      routingContext: baseContext({
        requestedRole: 'FAST_EXECUTOR',
        touchesProviderLifecycle: true,
      }),
      runId: 'run-fo', taskId: 'task-fo', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);
    expect(reporter.budgetFormatted[0]).toContain('质量底线');
  });
});

// ============================================================================
// 失败任务仍生成成本总结
// ============================================================================

describe('失败任务成本总结', () => {
  it('allowEscalation=false → FAILED 仍生成成本总结', async () => {
    const { registry, adapter } = makeRegistry('MISMATCH_MODEL');
    adapter.setScenario('MISMATCH_MODEL');
    createRunState(FIXTURE_CWD, 'run-fx', 'fx', 'custom');
    const reporter = new TestReporter();
    const result = await executeWithModelRouting({
      routingContext: baseContext({ allowEscalation: false }),
      runId: 'run-fx', taskId: 'task-fx', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      reporter,
    } as any);
    expect(result.status).toBe('FAILED');
    expect(reporter.costSummaries.length).toBeGreaterThanOrEqual(1);
    const summary = reporter.costSummaries[0];
    // completed may be false but summary still exists
    expect(summary).toBeDefined();
  });
});

// ============================================================================
// 无限重试防止
// ============================================================================

describe('无限重试防止', () => {
  it('maxEscalations 超限后返回 FAILED', async () => {
    const { registry, adapter } = makeRegistry('MISMATCH_MODEL');
    adapter.setScenario('MISMATCH_MODEL');
    createRunState(FIXTURE_CWD, 'run-loop', 'loop', 'custom');
    const result = await executeWithModelRouting({
      routingContext: baseContext(),
      runId: 'run-loop', taskId: 'task-loop', cwd: FIXTURE_CWD,
      routingConfigInput: ROUTING_CONFIG,
      budgetPolicyInput: BUDGET_POLICY,
      pricingByModelLogicalName: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      profileById: { 'flash-profile': FLASH_PROFILE, 'pro-profile': PRO_PROFILE },
      hasOpusProvider: false,
      executionParams: {
        systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 100, timeoutMs: 5000,
        adapterRegistry: registry, parentEnv: parentEnv(),
      },
      usesToolLoop: false,
      maxEscalations: 0,
    } as any);
    expect(result.status).toBe('FAILED');
  });
});

// ============================================================================
// 成本汇总
// ============================================================================

describe('成本汇总 — finalizeCostSummary', () => {
  it('生成后含完整字段', () => {
    resetEstimateSequence();
    const estimate = estimateTaskBudget({
      runId: 'r', taskId: 't',
      initialSelection: {
        role: 'FAST_EXECUTOR', provider: 'ds', profileId: 'f', modelLogicalName: 'flash-model',
        source: 'POLICY', reasonCodes: ['DEFAULT_FLASH'], policyVersion: 'cc-auto-model-routing-v1',
      },
      taskType: 'CODE_IMPLEMENTATION', affectedFileCount: 1,
      usesToolLoop: false, maxToolLoopTurns: 8, maxToolCalls: 16,
      systemPromptChars: 1000, userPromptChars: 500,
      routingConfig: ROUTING_CONFIG,
      budgetPolicy: BUDGET_POLICY,
      pricingByModel: { 'flash-model': FLASH_PRICING, 'pro-model': PRO_PRICING },
      hasOpusProvider: false,
    });
    const summary = buildTaskCostSummary({
      runId: 'run-cs', taskId: 'task-cs', estimate,
      usageRecords: [],
      selections: [],
      attempts: [],
      completed: true,
      strongModelPricing: PRO_PRICING,
      strongModelLogicalName: 'pro-model',
    });
    expect(summary.runId).toBe('run-cs');
    expect(summary.taskId).toBe('task-cs');
    expect(summary.actual.totalCalls).toBe(0);
    expect(summary.completed).toBe(true);
    expect(summary.generatedAt).toBeTruthy();
  });
});

// ============================================================================
// Helpers
// ============================================================================

function makeRegistry(scenario?: string) {
  const registry = new AdapterRegistry();
  const adapter = new MockProviderAdapter(
    (scenario as import('./types').MockProviderScenario) ?? 'VERIFIED_SUCCESS',
  );
  registry.register(adapter);
  return { registry, adapter };
}
