/** modelIdentity.spec.ts —— 模型身份三态判定测试 */
import { describe, it, expect } from 'vitest';
import { checkModelIdentity, findModelByIdentityLogicalName } from './modelIdentity';
import type { ProviderProfile } from './types';

const deepseekProfile: ProviderProfile = {
  id: 'deepseek-v4-pro',
  displayName: 'DeepSeek V4 Pro',
  vendor: 'deepseek',
  transport: 'openai-chat',
  credentialEnvVars: ['DEEPSEEK_API_KEY'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'deepseek',
  models: [
    {
      logicalName: 'deepseek',
      requestedModelId: 'deepseek-chat',
      acceptedReportedModelIds: ['deepseek-chat', 'deepseek-v3'],
      displayName: 'DeepSeek Chat',
    },
    {
      logicalName: 'deepseek-reasoner',
      requestedModelId: 'deepseek-reasoner',
      acceptedReportedModelIds: ['deepseek-reasoner'],
      displayName: 'DeepSeek Reasoner',
    },
  ],
  pricing: {
    'deepseek-chat': { inputPerMTokens: 1, outputPerMTokens: 2, cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1, currency: 'CNY', source: 'test', updatedAt: '2026-08-04' },
    'deepseek-reasoner': { inputPerMTokens: 4, outputPerMTokens: 8, cacheCreationPerMTokens: 5, cacheReadPerMTokens: 0.4, currency: 'CNY', source: 'test', updatedAt: '2026-08-04' },
  },
};

describe('checkModelIdentity', () => {
  // 13. 白名单命中 → VERIFIED
  it('returns VERIFIED when reportedModel is in acceptedReportedModelIds', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', 'deepseek-chat');
    expect(result.status).toBe('VERIFIED');
    expect(result.detail).toBe('');
  });

  it('returns VERIFIED for alternate accepted model ID in white list', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', 'deepseek-v3');
    expect(result.status).toBe('VERIFIED');
  });

  // 14. reportedModel === null → UNVERIFIED
  it('returns UNVERIFIED when reportedModel is null', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', null);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.detail).toContain('reportedModel=null');
  });

  // 15. 非白名单 → MISMATCH
  it('returns MISMATCH when reportedModel is not in acceptedReportedModelIds', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', 'gpt-4');
    expect(result.status).toBe('MISMATCH');
    expect(result.detail).toContain('gpt-4');
  });

  // 16. MISMATCH 返回正确 detail
  it('MISMATCH detail includes the unexpected model name', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', 'unknown-model');
    expect(result.status).toBe('MISMATCH');
    expect(result.detail).toContain('unknown-model');
    expect(result.detail).toContain('acceptedReportedModelIds');
  });

  // 17. MISMATCH 不因渠道别名自动扩大白名单
  it('does not widen the whitelist — only exact config match works', () => {
    // 'deepseek-chat-v2' 不在白名单中
    const result = checkModelIdentity(deepseekProfile, 'deepseek-chat', 'deepseek-chat-v2');
    expect(result.status).toBe('MISMATCH');
  });

  // 不同模型配置的白名单独立
  it('respects per-model whitelist — reasoner only accepts reasoner', () => {
    const result = checkModelIdentity(deepseekProfile, 'deepseek-reasoner', 'deepseek-chat');
    expect(result.status).toBe('MISMATCH');
  });

  // requestedModelId 不在配置中 → MISMATCH
  it('returns MISMATCH when requestedModelId is not in any ModelIdentity', () => {
    const result = checkModelIdentity(deepseekProfile, 'nonexistent-model', 'deepseek-chat');
    expect(result.status).toBe('MISMATCH');
  });
});

describe('findModelByIdentityLogicalName', () => {
  it('returns ModelIdentity for existing logicalName', () => {
    const m = findModelByIdentityLogicalName(deepseekProfile, 'deepseek');
    expect(m).toBeDefined();
    expect(m!.requestedModelId).toBe('deepseek-chat');
  });

  it('returns undefined for non-existing logicalName', () => {
    const m = findModelByIdentityLogicalName(deepseekProfile, 'nonexistent');
    expect(m).toBeUndefined();
  });
});
