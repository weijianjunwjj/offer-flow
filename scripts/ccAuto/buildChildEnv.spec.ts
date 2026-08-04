/** buildChildEnv.spec.ts —— 环境隔离测试 */
import { describe, it, expect } from 'vitest';
import { buildChildEnv, CredentialMissingError, credentialNamesForLog } from './buildChildEnv';
import type { ProviderProfile } from './types';

/** 构造仅用于测试的 ProviderProfile 模板 */
function makeProfile(overrides?: Partial<ProviderProfile>): ProviderProfile {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    vendor: 'deepseek',
    transport: 'openai-chat',
    credentialEnvVars: ['DEEPSEEK_API_KEY'],
    runtimeEnvAllowlist: ['PATH', 'HOME', 'LANG'],
    defaultModelId: 'test-model',
    models: [{ logicalName: 'test-model', requestedModelId: 'test-model-v1', acceptedReportedModelIds: ['test-model-v1'], displayName: 'Test' }],
    pricing: { 'test-model-v1': { inputPerMTokens: 1, outputPerMTokens: 2, cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1, currency: 'CNY', source: 'test', updatedAt: '2026-08-04' } },
    ...overrides,
  };
}

/** mock parentEnv */
function makeParentEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    HOME: '/home/user',
    LANG: 'en_US.UTF-8',
    DEEPSEEK_API_KEY: 'sk-fake-deepseek-key-1234',
    ANTHROPIC_API_KEY: 'sk-ant-fake-opus-key-5678',
    NODE_ENV: 'test',
    SECRET_TOKEN: 'super-secret',
    ...overrides,
  };
}

describe('buildChildEnv', () => {
  // 5. 只复制 allowlist
  it('copies only allowlisted variables', () => {
    const profile = makeProfile({ runtimeEnvAllowlist: ['PATH', 'HOME'] });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.PATH).toBe('/usr/bin');
    expect(childEnv.HOME).toBe('/home/user');
  });

  it('does not inherit non-allowlisted variables', () => {
    const profile = makeProfile({ runtimeEnvAllowlist: ['PATH'] });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.NODE_ENV).toBeUndefined();
    expect(childEnv.SECRET_TOKEN).toBeUndefined();
  });

  // 6. 只注入声明的 credentialEnvVars
  it('injects declared credential variables only', () => {
    const profile = makeProfile({ credentialEnvVars: ['DEEPSEEK_API_KEY'] });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.DEEPSEEK_API_KEY).toBe('sk-fake-deepseek-key-1234');
  });

  // 7. 缺失凭证 fail closed
  it('fails closed when credential variable is missing', () => {
    const profile = makeProfile({ credentialEnvVars: ['DEEPSEEK_API_KEY'] });
    const parentEnv = makeParentEnv({ DEEPSEEK_API_KEY: undefined });
    expect(() => buildChildEnv(profile, parentEnv)).toThrow(CredentialMissingError);
  });

  it('fails closed when credential variable is empty string', () => {
    const profile = makeProfile({ credentialEnvVars: ['DEEPSEEK_API_KEY'] });
    const parentEnv = makeParentEnv({ DEEPSEEK_API_KEY: '' });
    expect(() => buildChildEnv(profile, parentEnv)).toThrow(CredentialMissingError);
  });

  it('CredentialMissingError includes providerId and missing var name', () => {
    const profile = makeProfile({ credentialEnvVars: ['DEEPSEEK_API_KEY'] });
    const parentEnv = makeParentEnv({ DEEPSEEK_API_KEY: undefined });
    try {
      buildChildEnv(profile, parentEnv);
      expect.fail('Expected CredentialMissingError');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialMissingError);
      const ce = err as CredentialMissingError;
      expect(ce.providerId).toBe('test-provider');
      expect(ce.missingVar).toBe('DEEPSEEK_API_KEY');
    }
  });

  // 8. parentEnv 不被修改
  it('does not modify parentEnv', () => {
    const profile = makeProfile();
    const parentEnv = makeParentEnv();
    const originalKeys = Object.keys(parentEnv).sort();
    buildChildEnv(profile, parentEnv);
    expect(Object.keys(parentEnv).sort()).toEqual(originalKeys);
  });

  // 9. 不继承未授权变量
  it('does not inherit credentials not in credentialEnvVars', () => {
    const profile = makeProfile({
      credentialEnvVars: ['DEEPSEEK_API_KEY'],
      runtimeEnvAllowlist: [],
    });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  // 10/11. 跨 Provider 凭证隔离
  it('DeepSeek environment does not contain Anthropic credentials', () => {
    const deepseekProfile = makeProfile({
      id: 'ds-profile',
      vendor: 'deepseek',
      credentialEnvVars: ['DEEPSEEK_API_KEY'],
      runtimeEnvAllowlist: ['PATH'],
    });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(deepseekProfile, parentEnv);
    expect(childEnv.DEEPSEEK_API_KEY).toBeDefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('Anthropic environment does not contain DeepSeek credentials', () => {
    const anthropicProfile = makeProfile({
      id: 'ant-profile',
      vendor: 'anthropic',
      credentialEnvVars: ['ANTHROPIC_API_KEY'],
      runtimeEnvAllowlist: ['PATH'],
    });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(anthropicProfile, parentEnv);
    expect(childEnv.ANTHROPIC_API_KEY).toBeDefined();
    expect(childEnv.DEEPSEEK_API_KEY).toBeUndefined();
  });

  // Allowlist 变量 不存在于 parentEnv 时不注入
  it('skips allowlisted variables not present in parentEnv', () => {
    const profile = makeProfile({ runtimeEnvAllowlist: ['PATH', 'NONEXISTENT_VAR'] });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.NONEXISTENT_VAR).toBeUndefined();
  });

  // staticEnv 合并
  it('merges staticEnv into child environment', () => {
    const profile = makeProfile({
      staticEnv: { CUSTOM_VAR: 'hello', ANOTHER: 'world' },
    });
    const parentEnv = makeParentEnv();
    const { childEnv } = buildChildEnv(profile, parentEnv);
    expect(childEnv.CUSTOM_VAR).toBe('hello');
    expect(childEnv.ANOTHER).toBe('world');
  });

  // 12. 日志不出现凭证正文
  it('credentialNamesForLog returns only variable names, not values', () => {
    const names = credentialNamesForLog(['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']);
    expect(names).toContain('DEEPSEEK_API_KEY');
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('sk-');
    expect(names).not.toContain('fake');
  });

  // credentialVarNames 列表完整性
  it('returns credentialVarNames in result', () => {
    const profile = makeProfile({ credentialEnvVars: ['DEEPSEEK_API_KEY'] });
    const parentEnv = makeParentEnv();
    const { credentialVarNames } = buildChildEnv(profile, parentEnv);
    expect(credentialVarNames).toEqual(['DEEPSEEK_API_KEY']);
  });
});
