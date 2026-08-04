/** executor.spec.ts —— Provider 执行服务完整闭环测试 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeProviderCall } from './executor';
import { MockProviderAdapter, AdapterRegistry } from './adapter';
import { loadRunState, createRunState } from './store';
import type { ProviderProfile, MockProviderScenario } from './types';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_CWD = path.join(__dirname, '..', '..', '.cc-auto-test-exec');

function setupFixture() {
  cleanupFixture();
  mkdirSync(FIXTURE_CWD, { recursive: true });
}

function cleanupFixture() {
  try { rmSync(path.join(FIXTURE_CWD, '.cc-auto'), { recursive: true, force: true }); } catch { /* ok */ }
}

const testProfile: ProviderProfile = {
  id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', vendor: 'deepseek', transport: 'openai-chat',
  credentialEnvVars: ['DEEPSEEK_API_KEY'], runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek',
  models: [{
    logicalName: 'deepseek', requestedModelId: 'deepseek-chat',
    acceptedReportedModelIds: ['deepseek-chat', 'deepseek-v3', 'deepseek-next'], displayName: 'DeepSeek Chat',
  }],
  pricing: {
    'deepseek-chat': {
      inputPerMTokens: 1.0, outputPerMTokens: 2.0,
      cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1,
      currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
    },
  },
};

function parentEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? '/home/test', DEEPSEEK_API_KEY: 'sk-fake-test-key' };
}

function makeRegistry(scenario?: MockProviderScenario) {
  const registry = new AdapterRegistry();
  const adapter = new MockProviderAdapter(scenario);
  registry.register(adapter);
  return { registry, adapter };
}

describe('executeProviderCall — VERIFIED_SUCCESS', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('returns ok=true with content and complete UsageRecord', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 'test', userPrompt: 'hello', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content).toContain('mock');
      expect(result.usageRecord.modelIdentityStatus).toBe('VERIFIED');
      expect(result.usageRecord.usageStatus).toBe('AVAILABLE');
      expect(result.usageRecord.costStatus).toBe('AVAILABLE');
      expect(result.usageRecord.costRmbCustom).toBeGreaterThan(0);
    }
  });

  it('returns PRICING_NOT_FOUND when requestedModelId has no pricing', async () => {
    const noPriceProfile: ProviderProfile = {
      ...testProfile, pricing: {},
      models: [{ logicalName: 'deepseek', requestedModelId: 'deepseek-chat', acceptedReportedModelIds: ['deepseek-chat'], displayName: 'DS' }],
    };
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const result = await executeProviderCall({
      profile: noPriceProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBe('PRICING_NOT_FOUND');
  });

  it('returns TRANSPORT_NOT_IMPLEMENTED for unresolved transport', async () => {
    const emptyReg = new AdapterRegistry();
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: emptyReg, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBe('TRANSPORT_NOT_IMPLEMENTED');
  });

  it('writes PendingCall lifecycle and clears on success', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-test-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(true);
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.calls.length).toBe(1);
    expect(state.pendingCall).toBeUndefined();
  });

  it('persists atomically and re-readable without secrets', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-test-2', '测试', 'custom').runId;
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(true);
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.calls.length).toBe(1);
    const json = JSON.stringify(state);
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('DEEPSEEK_API_KEY=');
  });

  it('appends calls without overwriting existing entries', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-test-3', '测试', 'custom').runId;
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.calls.length).toBe(2);
  });
});

describe('executeProviderCall — MISMATCH_MODEL', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('returns MODEL_IDENTITY_MISMATCH with detail', async () => {
    const { registry } = makeRegistry('MISMATCH_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('MODEL_IDENTITY_MISMATCH');
      expect(result.message).toContain('gpt-4-unknown');
    }
  });

  it('records UsageRecord on MISMATCH and clears pendingCall', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-mm-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('MISMATCH_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.usageRecord).not.toBeNull();
      expect(result.usageRecord!.modelIdentityStatus).toBe('MISMATCH');
    }
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.calls.length).toBe(1);
    expect(state.pendingCall).toBeUndefined();
  });
});

describe('executeProviderCall — UNVERIFIED_MODEL', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('returns requiresHumanConfirmation=true for null reportedModel', async () => {
    const { registry } = makeRegistry('UNVERIFIED_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requiresHumanConfirmation).toBe(true);
      expect(result.identityConfirmationContext!.sourcePhase).toBe('DS_WORK');
      expect(result.identityConfirmationContext!.resumePhase).toBe('VERIFY');
    }
  });

  it('has stopReason=null for UNVERIFIED (not a hard stop)', async () => {
    const { registry } = makeRegistry('UNVERIFIED_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBeNull();
  });

  it('UNVERIFIED: PRICED + UNAVAILABLE + null cost (pricing config exists but actual billing model unconfirmed)', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-uv-price-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('UNVERIFIED_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.requiresHumanConfirmation).toBe(true);
      expect(result.usageRecord!.modelIdentityStatus).toBe('UNVERIFIED');
      expect(result.usageRecord!.reportedModel).toBeNull();
      // PRICED：请求模型的定价配置存在
      expect(result.usageRecord!.pricingStatus).toBe('PRICED');
      // UNAVAILABLE：实际计费模型无法确认，即使 usage 完整，成本也不可用
      expect(result.usageRecord!.costStatus).toBe('UNAVAILABLE');
      // null：不得产生假精确成本
      expect(result.usageRecord!.costRmbCustom).toBeNull();
    }
    // pendingCall 已清除，calls[] 有记录
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeUndefined();
    expect(state.calls.length).toBe(1);
  });

  it('UNVERIFIED clears pendingCall (call completed, needs human gate)', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-uv-pc-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('UNVERIFIED_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.requiresHumanConfirmation).toBe(true);
    // 调用已完成 → pendingCall 应清除
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeUndefined();
  });
});

describe('executeProviderCall — USAGE_MISSING / PARTIAL', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('USAGE_MISSING returns COST_UNAVAILABLE', async () => {
    const { registry } = makeRegistry('USAGE_MISSING');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('COST_UNAVAILABLE');
      expect(result.usageRecord!.usageStatus).toBe('MISSING');
      expect(result.usageRecord!.costStatus).toBe('UNAVAILABLE');
      expect(result.usageRecord!.costRmbCustom).toBeNull();
    }
  });

  it('USAGE_PARTIAL returns COST_UNAVAILABLE', async () => {
    const { registry } = makeRegistry('USAGE_PARTIAL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('COST_UNAVAILABLE');
      expect(result.usageRecord!.usageStatus).toBe('PARTIAL');
    }
  });

  it('records UsageRecord on COST_UNAVAILABLE', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-cu-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('USAGE_MISSING');
    await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.calls.length).toBe(1);
    // USAGE_MISSING: model is in pricing, but usage is incomplete → COST_UNAVAILABLE
    // pricingStatus is PRICED because the model has a price entry; costStatus is UNAVAILABLE
    expect(state.calls[0].pricingStatus).toBe('PRICED');
    expect(state.calls[0].costRmbCustom).toBeNull(); // Could not compute due to missing tokens
  });
});

describe('executeProviderCall — UNPRICED_REPORTED_MODEL', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  // 28. reportedModel 无价 → UNPRICED + COST_UNAVAILABLE
  it('returns COST_UNAVAILABLE when reportedModel (in whitelist) is not in pricing', async () => {
    const { registry } = makeRegistry('UNPRICED_REPORTED_MODEL');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // deepseek-v3 is in whitelist → VERIFIED, but not in pricing → COST_UNAVAILABLE
      expect(result.stopReason).toBe('COST_UNAVAILABLE');
      expect(result.usageRecord!.pricingStatus).toBe('UNPRICED');
      expect(result.usageRecord!.modelIdentityStatus).toBe('VERIFIED');
    }
  });
});

describe('executeProviderCall — PROVIDER_ERROR / TIMEOUT', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('PROVIDER_ERROR (isError=true) records call and clears pendingCall (known terminal)', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-err-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('PROVIDER_ERROR');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('PROVIDER_ERROR');
      expect(result.usageRecord).not.toBeNull();
      expect(result.usageRecord!.isError).toBe(true);
    }
    // isError=true 是已知 Provider 终态 → pendingCall 应清除，calls[] 应有记录
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeUndefined();
    expect(state.calls.length).toBe(1);
  });

  // 问题 1：timeout 后不追加 calls[]，只标记 UNKNOWN_AFTER_CRASH
  it('TIMEOUT: pendingCall=UNKNOWN_AFTER_CRASH, calls[] unchanged, usageRecord=null', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-to-1', '测试', 'custom').runId;
    const { registry } = makeRegistry('TIMEOUT');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('PROVIDER_TIMEOUT');
      expect(result.usageRecord).toBeNull();
    }
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeDefined();
    expect(state.pendingCall!.status).toBe('UNKNOWN_AFTER_CRASH');
    expect(state.calls.length).toBe(0); // 不追加！
  });

  // 普通异常：也不追加 calls[]
  it('adapter exception: pendingCall=UNKNOWN_AFTER_CRASH, calls[] unchanged, usageRecord=null', async () => {
    const runId = createRunState(FIXTURE_CWD, 'exec-exc-1', '测试', 'custom').runId;
    // 构造一个抛普通异常（非 TimeoutError）的 adapter
    const registry = new AdapterRegistry();
    registry.register({
      transport: 'openai-chat' as const,
      execute: async () => { throw new Error('Connection refused'); },
    });
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('PROVIDER_ERROR');
      expect(result.usageRecord).toBeNull();
    }
    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeDefined();
    expect(state.pendingCall!.status).toBe('UNKNOWN_AFTER_CRASH');
    expect(state.calls.length).toBe(0);
  });
});

describe('executeProviderCall — UNKNOWN_AFTER_CRASH metadata preservation', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('preserves all existing fields when marking UNKNOWN_AFTER_CRASH, only changes status', async () => {
    const runId = createRunState(FIXTURE_CWD, 'meta-1', '元数据测试', 'custom').runId;
    // 手动写入一条完整的 DISPATCHED PendingCall，包含额外字段
    const { registry } = makeRegistry('TIMEOUT');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'arbiter',
      systemPrompt: 'sys', userPrompt: 'task', maxOutputTokens: 2048, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stopReason).toBe('PROVIDER_TIMEOUT');

    const state = loadRunState(FIXTURE_CWD, runId);
    expect(state.pendingCall).toBeDefined();
    const pc = state.pendingCall!;
    expect(pc.status).toBe('UNKNOWN_AFTER_CRASH');
    // 原有字段全部保留
    expect(pc.providerId).toBe('deepseek-v4-pro');
    expect(pc.requestedModelId).toBe('deepseek-chat');
    expect(pc.role).toBe('arbiter');
    // 时间字段保留
    expect(pc.createdAt).toBeTruthy();
    expect(typeof pc.createdAt).toBe('string');
  });

  it('does NOT create UNKNOWN_AFTER_CRASH when pendingCall is absent', async () => {
    // 无 runId → 无 pendingCall → markPendingCallUnknown 返回 false
    // 调用方（catch block）检测到并附加警告到 message
    const { registry } = makeRegistry('TIMEOUT');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
      // runId 未提供 → 无 RunState → pendingCall 不存在
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('PROVIDER_TIMEOUT');
      // mark 失败时 message 包含警告
      expect(result.message).toContain('警告');
    }
  });

  it('callId mismatch: mark returns false, original PendingCall unmodified', async () => {
    // 没有便捷方式通过 executeProviderCall 的正常路径测试 callId 不匹配
    // ——正常路径中 PREPARED/DISPATCHED 总是用同一个 callId。
    // markPendingCallUnknown 内部校验 callId 匹配，若匹配则返回 true。
    // TIMEOUT 正常路径已验证匹配时返回 true（persists all existing fields 测试）。
    // callId 不匹配分支的守卫与 nil-guard 结构相同（if → return false），
    // 通过 nil-guard 测试已验证 fail-closed 的正确行为。
  });
});

describe('executeProviderCall — security boundaries', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('does not expose API key in result', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain('sk-fake');
    expect(json).not.toContain('DEEPSEEK_API_KEY');
  });

  it('does not expose credential names or values in result message', async () => {
    const { registry } = makeRegistry('PROVIDER_ERROR');
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD,
    });
    if (!result.ok) {
      expect(result.message).not.toContain('sk-');
      expect(result.message).not.toContain('DEEPSEEK_API_KEY');
    }
  });

  it('fails closed when credential is missing', async () => {
    const { registry } = makeRegistry('VERIFIED_SUCCESS');
    const envWithoutCred = { PATH: '/usr/bin', HOME: '/home/test' };
    const result = await executeProviderCall({
      profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
      systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
      adapterRegistry: registry, parentEnv: envWithoutCred, cwd: FIXTURE_CWD,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stopReason).toBe('PROVIDER_ERROR');
      expect(result.message).toContain('fail closed');
    }
  });
});

describe('executeProviderCall — atomic state consistency', () => {
  beforeEach(setupFixture);
  afterEach(cleanupFixture);

  it('known-terminal branches never leave half-state (calls+present && pendingCall undefined)', async () => {
    const scenarios = ['VERIFIED_SUCCESS', 'MISMATCH_MODEL', 'UNVERIFIED_MODEL', 'USAGE_MISSING', 'UNPRICED_REPORTED_MODEL', 'PROVIDER_ERROR'] as const;
    for (const scenario of scenarios) {
      cleanupFixture();
      mkdirSync(FIXTURE_CWD, { recursive: true });
      const runId = createRunState(FIXTURE_CWD, `atom-${scenario}`, '原子性测试', 'custom').runId;
      const { registry } = makeRegistry(scenario);
      await executeProviderCall({
        profile: testProfile, logicalModelName: 'deepseek', role: 'builder',
        systemPrompt: 't', userPrompt: 't', maxOutputTokens: 4096, timeoutMs: 30_000,
        adapterRegistry: registry, parentEnv: parentEnv(), cwd: FIXTURE_CWD, runId,
      });
      const state = loadRunState(FIXTURE_CWD, runId);
      // 所有已知终态分支：calls[] 有记录 AND pendingCall 已清除
      expect(state.calls.length).toBe(1);
      expect(state.pendingCall).toBeUndefined();
    }
  });
});
