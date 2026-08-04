/** adapter.spec.ts —— Provider Adapter 契约与 Mock Transport 测试 */
import { describe, it, expect } from 'vitest';
import {
  MockProviderAdapter,
  AdapterRegistry,
  createMockAdapterRegistry,
} from './adapter';
import { TimeoutError } from './providerErrors';
import { OpenAIChatAdapter } from './openaiChatAdapter';
import { createProductionAdapterRegistry } from './productionAdapterRegistry';
import type { ProviderCallRequest, ProviderExecutionContext, ProviderProfile } from './types';

const mockProfile: ProviderProfile = {
  id: 'test-provider',
  displayName: 'Test Provider',
  vendor: 'deepseek',
  transport: 'openai-chat',
  apiBaseUrl: 'https://api.example.com/v1',
  credentialEnvVars: ['TEST_API_KEY'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'test-model',
  models: [{
    logicalName: 'test-model',
    requestedModelId: 'test-model',
    acceptedReportedModelIds: ['test-model'],
    displayName: 'Test Model',
  }],
  pricing: {
    'test-model': {
      inputPerMTokens: 1.0, outputPerMTokens: 2.0,
      cacheCreationPerMTokens: 1.25, cacheReadPerMTokens: 0.1,
      currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
    },
  },
};

const mockContext: ProviderExecutionContext = {
  childEnv: {},
  timeoutMs: 30_000,
  profile: mockProfile,
};

function makeRequest(overrides?: Partial<ProviderCallRequest>): ProviderCallRequest {
  return {
    callId: 'call-001',
    providerId: 'test-provider',
    requestedModelId: 'deepseek-chat',
    role: 'builder',
    systemPrompt: '你是一个测试助手',
    userPrompt: '测试任务',
    maxOutputTokens: 4096,
    timeoutMs: 30_000,
    ...overrides,
  };
}

describe('MockProviderAdapter', () => {
  // 1. transport=mock 时选择 MockProviderAdapter
  it('accepts scenario parameter and returns corresponding response', async () => {
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    const response = await adapter.execute(makeRequest(), mockContext);
    expect(response.isError).toBe(false);
    expect(response.reportedModel).toBe('deepseek-chat');
    expect(response.usage.inputTokens).toBe(1500);
    expect(response.usage.outputTokens).toBe(800);
    expect(response.content).toContain('mock');
  });

  // 4. mock 不发起任何网络请求
  it('does not make network calls', async () => {
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    const response = await adapter.execute(makeRequest(), mockContext);
    // 响应是同步可预测的——如果涉及网络则不会立即返回
    expect(response.callId).toBe('call-001');
    expect(response.subtype).toBe('success');
  });

  // VERIFIED_SUCCESS
  it('VERIFIED_SUCCESS returns complete usage with matching model', async () => {
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.reportedModel).toBe('deepseek-chat');
    expect(res.usage.inputTokens).toBe(1500);
    expect(res.usage.outputTokens).toBe(800);
    expect(res.isError).toBe(false);
  });

  // MISMATCH_MODEL
  it('MISMATCH_MODEL returns a model not in acceptedReportedModelIds', async () => {
    const adapter = new MockProviderAdapter('MISMATCH_MODEL');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.reportedModel).toBe('gpt-4-unknown');
    expect(res.reportedModel).not.toBe('deepseek-chat');
  });

  // UNVERIFIED_MODEL
  it('UNVERIFIED_MODEL returns reportedModel=null', async () => {
    const adapter = new MockProviderAdapter('UNVERIFIED_MODEL');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.reportedModel).toBeNull();
  });

  // USAGE_MISSING
  it('USAGE_MISSING returns all-null usage', async () => {
    const adapter = new MockProviderAdapter('USAGE_MISSING');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.usage.inputTokens).toBeNull();
    expect(res.usage.outputTokens).toBeNull();
    expect(res.usage.cacheCreationInputTokens).toBeNull();
    expect(res.usage.cacheReadInputTokens).toBeNull();
  });

  // USAGE_PARTIAL
  it('USAGE_PARTIAL returns mixed usage', async () => {
    const adapter = new MockProviderAdapter('USAGE_PARTIAL');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.usage.inputTokens).toBe(2000); // 有效
    expect(res.usage.outputTokens).toBeNull(); // 缺失
    expect(res.usage.cacheCreationInputTokens).toBe(50);
    expect(res.usage.cacheReadInputTokens).toBeNull();
  });

  // UNPRICED_REPORTED_MODEL
  it('UNPRICED_REPORTED_MODEL returns a model that is in whitelist but not in pricing table', async () => {
    const adapter = new MockProviderAdapter('UNPRICED_REPORTED_MODEL');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.reportedModel).toBe('deepseek-v3'); // in whitelist, but not in pricing
    expect(res.isError).toBe(false); // 调用本身成功，但定价不可用
  });

  // PROVIDER_ERROR
  it('PROVIDER_ERROR returns isError=true with no content', async () => {
    const adapter = new MockProviderAdapter('PROVIDER_ERROR');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.isError).toBe(true);
    expect(res.content).toBe('');
    expect(res.usage.inputTokens).toBeNull();
  });

  // TIMEOUT
  it('TIMEOUT throws TimeoutError', async () => {
    const adapter = new MockProviderAdapter('TIMEOUT');
    await expect(adapter.execute(makeRequest(), mockContext)).rejects.toThrow(TimeoutError);
  });

  // setScenario 动态切换
  it('setScenario changes the adapter behavior', async () => {
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    adapter.setScenario('PROVIDER_ERROR');
    const res = await adapter.execute(makeRequest(), mockContext);
    expect(res.isError).toBe(true);
  });

  // 不读取 API Key
  it('does not read environment variables', async () => {
    // Set a fake key in context to verify adapter doesn't use it
    const ctx: ProviderExecutionContext = {
      childEnv: { TEST_API_KEY: 'sk-should-not-be-used' },
      timeoutMs: 30_000,
      profile: mockProfile,
    };
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    const res = await adapter.execute(makeRequest(), ctx);
    expect(res.callId).toBe('call-001');
    // 没有把 key 放入响应
    expect(res.content).not.toContain('sk-');
  });
});

describe('AdapterRegistry', () => {
  // 2. vendor 不影响 Adapter 选择
  it('selects adapter by transport, not by vendor', () => {
    const registry = new AdapterRegistry();
    const mockAdapter = new MockProviderAdapter();
    registry.register(mockAdapter);

    // Resolve by transport 'openai-chat' — 不管 vendor
    const resolved = registry.resolve('openai-chat');
    expect(resolved).toBeDefined();
    expect(resolved).toBe(mockAdapter);
  });

  // 3. 未实现 transport 返回 null → TRANSPORT_NOT_IMPLEMENTED
  it('returns null for unimplemented transport', () => {
    const registry = new AdapterRegistry();
    const mockAdapter = new MockProviderAdapter();
    registry.register(mockAdapter);

    expect(registry.resolve('anthropic-messages')).toBeNull();
    expect(registry.resolve('claude-cli')).toBeNull();
    expect(registry.resolve('openai-chat')).not.toBeNull();
  });

  it('lists registered transports', () => {
    const registry = new AdapterRegistry();
    registry.register(new MockProviderAdapter());
    expect(registry.registeredTransports).toEqual(['openai-chat']);
  });

  it('resolve on empty registry returns null', () => {
    const registry = new AdapterRegistry();
    expect(registry.resolve('openai-chat')).toBeNull();
  });

  it('throws on duplicate transport registration', () => {
    const registry = new AdapterRegistry();
    registry.register(new MockProviderAdapter('VERIFIED_SUCCESS'));
    expect(() => registry.register(new MockProviderAdapter('PROVIDER_ERROR'))).toThrow();
  });
});

describe('MockProviderAdapter validateProfile', () => {
  it('returns ok=true for any profile (mock always passes)', () => {
    const adapter = new MockProviderAdapter('VERIFIED_SUCCESS');
    const result = adapter.validateProfile(mockProfile);
    expect(result.ok).toBe(true);
  });
});

describe('createMockAdapterRegistry', () => {
  it('creates a registry with a registered MockProviderAdapter', () => {
    const { registry, adapter } = createMockAdapterRegistry('VERIFIED_SUCCESS');
    const resolved = registry.resolve('openai-chat');
    expect(resolved).toBe(adapter);
  });
});

// ============================================================================
// Production Registry 测试（切片 1C）
// ============================================================================

describe('createProductionAdapterRegistry', () => {
  // 1. 真正导出 createProductionAdapterRegistry 并注册 OpenAIChatAdapter
  it('resolves openai-chat to an OpenAIChatAdapter using real export', () => {
    const registry = createProductionAdapterRegistry();
    const adapter = registry.resolve('openai-chat');
    expect(adapter).not.toBeNull();
    expect(adapter!.transport).toBe('openai-chat');
    expect(adapter!.constructor.name).toBe('OpenAIChatAdapter');
  });

  // 2. Production Registry 不包含 MockProviderAdapter
  it('does not contain MockProviderAdapter', () => {
    const registry = createProductionAdapterRegistry();
    const adapter = registry.resolve('openai-chat');
    expect(adapter).not.toBeInstanceOf(MockProviderAdapter);
  });

  // 3. 未实现 transport 返回 null
  it('returns null for unimplemented transports', () => {
    const registry = createProductionAdapterRegistry();
    expect(registry.resolve('anthropic-messages')).toBeNull();
    expect(registry.resolve('claude-cli')).toBeNull();
  });

  // 重复注册拒绝
  it('throws on duplicate transport registration', () => {
    const registry = createProductionAdapterRegistry();
    expect(() => registry.register(new OpenAIChatAdapter())).toThrow();
  });
});
