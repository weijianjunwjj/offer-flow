/** provider.spec.ts —— Provider 配置加载与校验测试 */
import { describe, it, expect } from 'vitest';
import { validateProviderProfile, loadProviderProfiles } from './provider';
import type { CcAutoConfig } from './config';

function makeConfig(overrides?: Record<string, unknown>): CcAutoConfig {
  return {
    budget: { simpleTaskRmb: 3, normalTaskRmb: 10, complexTaskRmb: 25, absoluteTaskMaxRmb: 30, dailyMaxRmb: 50, opusShareMax: 0.15 },
    limits: { maxRepairCycles: 2, maxOpusCalls: 1, maxHandoffs: 1, maxContextFiles: 12, maxChangedFiles: 15 },
    models: { scout: { model: 'x', effort: 'low', maxTurns: 1 }, builderDefault: { model: 'x', effort: 'medium', maxTurns: 1 }, builderHighRisk: { model: 'x', effort: 'high', maxTurns: 1 }, arbiter: { model: 'x', effort: 'high', maxTurns: 1 } },
    usdToRmbRate: 7.2,
    pricingMode: 'custom',
    customPricing: { x: { inputPerMTokens: 1, outputPerMTokens: 1, cacheCreationPerMTokens: 1, cacheReadPerMTokens: 1 } },
    providerProfiles: overrides ?? {},
  };
}

const validProfile = {
  displayName: 'DeepSeek V4 Pro',
  vendor: 'deepseek' as const,
  transport: 'openai-chat' as const,
  apiBaseUrl: 'https://api.deepseek.com/v1',
  credentialEnvVars: ['DEEPSEEK_API_KEY'],
  runtimeEnvAllowlist: ['PATH', 'HOME'],
  defaultModelId: 'deepseek',
  models: [
    {
      logicalName: 'deepseek',
      requestedModelId: 'deepseek-chat',
      acceptedReportedModelIds: ['deepseek-chat', 'deepseek-v3'],
      displayName: 'DeepSeek Chat',
    },
  ],
  pricing: {
    'deepseek-chat': {
      inputPerMTokens: 1.0,
      outputPerMTokens: 2.0,
      cacheCreationPerMTokens: 1.25,
      cacheReadPerMTokens: 0.1,
      currency: 'CNY' as const,
      source: 'third-party-2026-08',
      updatedAt: '2026-08-04',
    },
  },
};

describe('validateProviderProfile', () => {
  it('accepts a valid ProviderProfile', () => {
    const result = validateProviderProfile('test', validProfile);
    expect(result.ok).toBe(true);
    expect(result.profile!.id).toBe('test');
  });

  it('rejects when defaultModelId is not in any model logicalName', () => {
    const bad = { ...validProfile, defaultModelId: 'nonexistent' };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('defaultModelId');
  });

  it('rejects when requestedModelId has no pricing', () => {
    const bad = { ...validProfile, pricing: {} };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('pricing');
  });

  it('rejects non-CNY currency', () => {
    const bad = {
      ...validProfile,
      pricing: { 'deepseek-chat': { ...validProfile.pricing['deepseek-chat'], currency: 'USD' as unknown as 'CNY' } },
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('CNY');
  });

  it('rejects negative pricing', () => {
    const bad = {
      ...validProfile,
      pricing: { 'deepseek-chat': { ...validProfile.pricing['deepseek-chat'], inputPerMTokens: -1 } },
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('inputPerMTokens');
  });

  it('rejects Infinity in pricing', () => {
    const bad = {
      ...validProfile,
      pricing: { 'deepseek-chat': { ...validProfile.pricing['deepseek-chat'], outputPerMTokens: Infinity } },
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
  });

  it('rejects credential-like keys in staticEnv', () => {
    const bad = { ...validProfile, staticEnv: { DEEPSEEK_API_KEY: 'sk-secret' } };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('staticEnv');
  });

  it('rejects "token" in staticEnv key', () => {
    const bad = { ...validProfile, staticEnv: { AUTH_TOKEN: 'secret' } };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('staticEnv');
  });

  it('rejects invalid vendor', () => {
    const bad = { ...validProfile, vendor: 'openai' };
    expect(validateProviderProfile('test', bad).ok).toBe(false);
  });

  it('rejects invalid transport', () => {
    const bad = { ...validProfile, transport: 'grpc' };
    expect(validateProviderProfile('test', bad).ok).toBe(false);
  });

  it('rejects empty acceptedReportedModelIds', () => {
    const bad = {
      ...validProfile,
      models: [{ logicalName: 'deepseek', requestedModelId: 'deepseek-chat', acceptedReportedModelIds: [], displayName: 'DS' }],
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('acceptedReportedModelIds');
  });

  // === 环境变量命名空间冲突（大小写不敏感）===

  // 1. staticEnv 与 credentialEnvVars 完全同名 → 拒绝
  it('rejects staticEnv key identical to credentialEnvVars key', () => {
    const bad = { ...validProfile, staticEnv: { DEEPSEEK_API_KEY: 'static-value' } };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });

  // 2. 大小写不同 → 拒绝
  it('rejects staticEnv key that differs only in case from credentialEnvVars', () => {
    const bad = { ...validProfile, staticEnv: { deepseek_api_key: 'static-value' } };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });

  // 3. runtimeEnvAllowlist 与 credentialEnvVars 同名 → 拒绝
  it('rejects runtimeEnvAllowlist containing credentialEnvVars key', () => {
    const bad = { ...validProfile, runtimeEnvAllowlist: ['PATH', 'DEEPSEEK_API_KEY'] };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });

  // 4. runtimeEnvAllowlist 含敏感变量（未声明在 credentialEnvVars）→ 拒绝
  it('rejects allowlist with suspicious credential-like var not in credentialEnvVars', () => {
    const bad = { ...validProfile, runtimeEnvAllowlist: ['PATH', 'ANTHROPIC_AUTH_TOKEN'] };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });

  // 5. credentialEnvVars 内部重复 → 拒绝
  it('rejects duplicate in credentialEnvVars (case-insensitive)', () => {
    const bad = {
      ...validProfile,
      credentialEnvVars: ['DEEPSEEK_API_KEY', 'deepseek_api_key'],
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });

  // 6. runtimeEnvAllowlist 内部重复 → 拒绝
  it('rejects duplicate in runtimeEnvAllowlist (case-insensitive)', () => {
    const bad = {
      ...validProfile,
      runtimeEnvAllowlist: ['PATH', 'path'],
    };
    const result = validateProviderProfile('test', bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('命名空间冲突');
  });
});

describe('loadProviderProfiles', () => {
  it('returns error when providerProfiles is missing', () => {
    const config = makeConfig();
    config.providerProfiles = undefined;
    const result = loadProviderProfiles(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('FILE_NOT_FOUND');
  });

  it('loads valid profiles from config', () => {
    const config = makeConfig({ 'deepseek-v4-pro': validProfile });
    const result = loadProviderProfiles(config);
    expect(result.ok).toBe(true);
    expect(result.profiles!['deepseek-v4-pro']).toBeDefined();
  });

  it('returns PRICING_NOT_FOUND for missing pricing', () => {
    const config = makeConfig({ 'deepseek-v4-pro': { ...validProfile, pricing: {} } });
    const result = loadProviderProfiles(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('PRICING_NOT_FOUND');
  });
});
