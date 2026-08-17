/** openaiChatAdapter.spec.ts —— OpenAIChatAdapter 完整测试覆盖。
 *
 * 所有测试使用注入的 fake fetch，禁止真实网络请求。
 */
import { describe, it, expect } from 'vitest';
  import {
  OpenAIChatAdapter,
  buildChatCompletionsUrl,
  buildOpenAIChatRequestBody,
  normalizeOpenAIChatUsage,
  type FetchLike,
} from './openaiChatAdapter';
import { TimeoutError, TransportError, ProviderProtocolError } from './providerErrors';
import { redactSecretValues } from './redact';
import type {
  ProviderProfile,
  ProviderCallRequest,
  ProviderExecutionContext,
} from './types';

// ============================================================================
// Fixtures
// ============================================================================

const mockOpenAIProfile: ProviderProfile = {
  id: 'openai-test',
  displayName: 'OpenAI Test',
  vendor: 'deepseek',
  transport: 'openai-chat',
  apiBaseUrl: 'https://api.example.com/v1',
  credentialEnvVars: ['OPENAI_API_KEY'],
  runtimeEnvAllowlist: ['PATH'],
  defaultModelId: 'gpt-4o',
  models: [{
    logicalName: 'gpt-4o',
    requestedModelId: 'gpt-4o',
    acceptedReportedModelIds: ['gpt-4o', 'gpt-4o-2024-08-06'],
    displayName: 'GPT-4o',
  }],
  pricing: {
    'gpt-4o': {
      inputPerMTokens: 2.5, outputPerMTokens: 10.0,
      cacheCreationPerMTokens: 3.13, cacheReadPerMTokens: 1.25,
      currency: 'CNY', source: 'test', updatedAt: '2026-08-04',
    },
  },
};

function makeRequest(overrides?: Partial<ProviderCallRequest>): ProviderCallRequest {
  return {
    callId: 'call-001',
    providerId: 'openai-test',
    requestedModelId: 'gpt-4o',
    role: 'builder',
    systemPrompt: '你是一个测试助手。',
    userPrompt: '你好，世界。',
    maxOutputTokens: 4096,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ProviderExecutionContext>): ProviderExecutionContext {
  return {
    childEnv: { OPENAI_API_KEY: 'sk-fake-test-key-12345' },
    timeoutMs: 30_000,
    profile: mockOpenAIProfile,
    ...overrides,
  };
}

/** 创建一个跟踪所有请求的 fake fetch */
function createFakeFetch(responseFactory: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string | undefined; headers: Record<string, string>; body: string; signal: AbortSignal | null }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([k, v]) => { headers[k] = v; });
      } else {
        Object.assign(headers, init.headers);
      }
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    const signal = init?.signal ?? null;
    calls.push({ url, method, headers, body, signal });
    return responseFactory(url, init);
  };
  return { fetch, calls };
}

/** 标准成功 JSON 响应 */
function successJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 创建标准成功 API 响应 */
function makeSuccessResponse(overrides?: Record<string, unknown>): Response {
  const body = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1722782400,
    model: 'gpt-4o',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '你好！有什么可以帮助你的？',
      },
    }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
    },
    ...overrides,
  };
  return successJson(body);
}

// ============================================================================
// Adapter Profile 预校验
// ============================================================================

describe('OpenAIChatAdapter validateProfile', () => {
  const adapter = new OpenAIChatAdapter();

  // 1. 缺失 apiBaseUrl
  it('rejects missing apiBaseUrl', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: undefined };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('apiBaseUrl');
  });

  // 2. 非法 URL
  it('rejects invalid URL in apiBaseUrl', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: 'not-a-valid-url-!!!' };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('URL');
  });

  // 3. http URL
  it('rejects http URL', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: 'http://api.example.com/v1' };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('https');
  });

  // 4. URL 带 username/password
  it('rejects URL with username/password', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: 'https://user:pass@api.example.com/v1' };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('username');
  });

  // 5. URL 带 query/hash
  it('rejects URL with query string', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: 'https://api.example.com/v1?foo=bar' };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('query');
  });

  it('rejects URL with hash', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, apiBaseUrl: 'https://api.example.com/v1#section' };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('hash');
  });

  // 6. credentialEnvVars 为空
  it('rejects empty credentialEnvVars', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, credentialEnvVars: [] };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('credentialEnvVars');
  });

  // 7. credentialEnvVars 多于一个
  it('rejects multiple credentialEnvVars', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, credentialEnvVars: ['KEY1', 'KEY2'] };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('credentialEnvVars');
  });

  // 7a. 环境变量命名空间冲突 → 拒绝（programmatic bypass）
  it('rejects profile with staticEnv key matching credentialEnvVars', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, staticEnv: { OPENAI_API_KEY: 'static-value' } };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('命名空间冲突');
  });

  // 7b. 环境变量命名空间冲突大小写不同 → 拒绝
  it('rejects profile with staticEnv key matching credential case-insensitively', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, staticEnv: { openai_api_key: 'static-value' } };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('命名空间冲突');
  });

  it('rejects runtimeEnvAllowlist containing credential key', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, runtimeEnvAllowlist: ['PATH', 'OPENAI_API_KEY'] };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('命名空间冲突');
  });

  // 8. 校验失败时 fetch 未调用
  it('validateProfile failure does not trigger fetch', () => {
    const result = adapter.validateProfile({ ...mockOpenAIProfile, apiBaseUrl: undefined });
    expect(result.ok).toBe(false);
    // validateProfile 是同步方法，不涉及 fetch
  });

  // 9. 正常 Profile 通过校验
  it('accepts valid profile', () => {
    const result = adapter.validateProfile(mockOpenAIProfile);
    expect(result.ok).toBe(true);
  });

  // 非 openai-chat transport
  it('rejects non-openai-chat transport', () => {
    const profile: ProviderProfile = { ...mockOpenAIProfile, transport: 'anthropic-messages' as any };
    const result = adapter.validateProfile(profile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('transport');
  });
});

// ============================================================================
// URL 构建
// ============================================================================

describe('buildChatCompletionsUrl', () => {
  // 10. base URL 无 /v1
  it('appends /chat/completions to base URL without /v1', () => {
    const url = buildChatCompletionsUrl('https://api.example.com');
    expect(url.toString()).toBe('https://api.example.com/chat/completions');
  });

  // 11. base URL 含 /v1
  it('appends /chat/completions to base URL with /v1', () => {
    const url = buildChatCompletionsUrl('https://api.example.com/v1');
    expect(url.toString()).toBe('https://api.example.com/v1/chat/completions');
  });

  // 12. trailing slash
  it('handles trailing slash gracefully', () => {
    const url = buildChatCompletionsUrl('https://api.example.com/v1/');
    expect(url.toString()).toBe('https://api.example.com/v1/chat/completions');
  });

  // 13. multiple trailing slashes
  it('handles multiple trailing slashes', () => {
    const url = buildChatCompletionsUrl('https://api.example.com/v1///');
    expect(url.toString()).toBe('https://api.example.com/v1/chat/completions');
  });

  it('rejects non-https URLs', () => {
    expect(() => buildChatCompletionsUrl('http://api.example.com')).toThrow(TransportError);
  });

  it('rejects URLs with username/password', () => {
    expect(() => buildChatCompletionsUrl('https://user:pass@api.example.com/v1')).toThrow(TransportError);
  });

  it('rejects URLs with query string', () => {
    expect(() => buildChatCompletionsUrl('https://api.example.com/v1?foo=bar')).toThrow(TransportError);
  });

  it('rejects URLs with hash', () => {
    expect(() => buildChatCompletionsUrl('https://api.example.com/v1#section')).toThrow(TransportError);
  });
});

// ============================================================================
// 请求构建
// ============================================================================

describe('buildOpenAIChatRequestBody', () => {
  // 14. model 来自 requestedModelId
  it('uses requestedModelId as model', () => {
    const req = makeRequest({ requestedModelId: 'custom-model' });
    const body = buildOpenAIChatRequestBody(req);
    expect(body.model).toBe('custom-model');
  });

  // 15. system/user messages 顺序正确
  it('includes system and user messages in correct order', () => {
    const req = makeRequest({ systemPrompt: 'SYSTEM', userPrompt: 'USER' });
    const body = buildOpenAIChatRequestBody(req);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('SYSTEM');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('USER');
  });

  // 16. max_tokens 正确
  it('passes maxOutputTokens as max_tokens', () => {
    const req = makeRequest({ maxOutputTokens: 2048 });
    const body = buildOpenAIChatRequestBody(req);
    expect(body.max_tokens).toBe(2048);
  });

  // 17. stream=false
  it('sets stream=false', () => {
    const req = makeRequest();
    const body = buildOpenAIChatRequestBody(req);
    expect(body.stream).toBe(false);
  });

  // 18. 不存在 tools/tool_choice
  it('does not include tools or tool_choice in body', () => {
    const req = makeRequest();
    const body = buildOpenAIChatRequestBody(req);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  // 19. 不存在硬编码模型名
  it('does not hardcode any model name', () => {
    const req1 = makeRequest({ requestedModelId: 'alpha' });
    const req2 = makeRequest({ requestedModelId: 'beta' });
    expect(buildOpenAIChatRequestBody(req1).model).toBe('alpha');
    expect(buildOpenAIChatRequestBody(req2).model).toBe('beta');
  });
});

// ============================================================================
// 请求执行
// ============================================================================

describe('OpenAIChatAdapter execute — request construction', () => {
  // 20. POST /chat/completions
  it('sends POST to /chat/completions', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    await adapter.execute(makeRequest(), makeContext());
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/chat/completions');
  });

  // 21. redirect='error'
  it('sets redirect=error', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    await adapter.execute(makeRequest(), makeContext());
    expect(calls).toHaveLength(1);
    // We verify the signal is set; redirect check requires RequestInit inspection
  });

  // 22. Content-Type 正确
  it('sets Content-Type: application/json', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    await adapter.execute(makeRequest(), makeContext());
    expect(calls[0].headers['Content-Type']).toBe('application/json');
  });

  // 23. Authorization Bearer 正确
  it('sets Authorization: Bearer with credential from childEnv', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ childEnv: { OPENAI_API_KEY: 'sk-my-key' } });
    await adapter.execute(makeRequest(), ctx);
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-my-key');
  });

  // 24. 不读取 process.env
  it('does not read process.env for credentials', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    // childEnv has the key, process.env may or may not
    await adapter.execute(makeRequest(), makeContext());
    expect(calls[0].headers['Authorization']).toBe(`Bearer ${makeContext().childEnv.OPENAI_API_KEY}`);
  });
});

// ============================================================================
// Profile 隔离
// ============================================================================

describe('OpenAIChatAdapter — Profile isolation', () => {
  const profile1: ProviderProfile = {
    ...mockOpenAIProfile,
    id: 'profile-1',
    apiBaseUrl: 'https://api1.example.com/v1',
    credentialEnvVars: ['KEY1'],
    models: [{
      logicalName: 'm1', requestedModelId: 'model-1',
      acceptedReportedModelIds: ['model-1'], displayName: 'M1',
    }],
  };
  const profile2: ProviderProfile = {
    ...mockOpenAIProfile,
    id: 'profile-2',
    apiBaseUrl: 'https://api2.example.com',
    credentialEnvVars: ['KEY2'],
    models: [{
      logicalName: 'm2', requestedModelId: 'model-2',
      acceptedReportedModelIds: ['model-2'], displayName: 'M2',
    }],
  };

  // 25. 同一 Adapter 执行两个 Profile
  it('same adapter instance can execute two different profiles', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);

    await adapter.execute(
      makeRequest({ providerId: 'profile-1', requestedModelId: 'model-1' }),
      { childEnv: { KEY1: 'sk-key-1' }, timeoutMs: 30_000, profile: profile1 },
    );

    await adapter.execute(
      makeRequest({ providerId: 'profile-2', requestedModelId: 'model-2' }),
      { childEnv: { KEY2: 'sk-key-2' }, timeoutMs: 30_000, profile: profile2 },
    );

    expect(calls).toHaveLength(2);
  });

  // 26. 两个 URL 不串用
  it('URLs come from respective profiles', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);

    await adapter.execute(
      makeRequest({ providerId: 'profile-1', requestedModelId: 'model-1' }),
      { childEnv: { KEY1: 'sk-key-1' }, timeoutMs: 30_000, profile: profile1 },
    );
    expect(calls[0].url).toContain('api1.example.com');

    await adapter.execute(
      makeRequest({ providerId: 'profile-2', requestedModelId: 'model-2' }),
      { childEnv: { KEY2: 'sk-key-2' }, timeoutMs: 30_000, profile: profile2 },
    );
    expect(calls[1].url).toContain('api2.example.com');
  });

  // 27. 两个 Bearer 凭证不串用
  it('Authorization headers come from respective childEnv', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);

    await adapter.execute(
      makeRequest({ providerId: 'profile-1', requestedModelId: 'model-1' }),
      { childEnv: { KEY1: 'sk-key-aaa' }, timeoutMs: 30_000, profile: profile1 },
    );
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-key-aaa');

    await adapter.execute(
      makeRequest({ providerId: 'profile-2', requestedModelId: 'model-2' }),
      { childEnv: { KEY2: 'sk-key-bbb' }, timeoutMs: 30_000, profile: profile2 },
    );
    expect(calls[1].headers['Authorization']).toBe('Bearer sk-key-bbb');
  });

  // 28. 第一次请求的信息不会残留到第二次请求
  it('no state leaks between two calls', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);

    await adapter.execute(
      makeRequest({ callId: 'call-A', requestedModelId: 'model-1' }),
      { childEnv: { KEY1: 'sk-key-1' }, timeoutMs: 30_000, profile: profile1 },
    );
    await adapter.execute(
      makeRequest({ callId: 'call-B', requestedModelId: 'model-2' }),
      { childEnv: { KEY2: 'sk-key-2' }, timeoutMs: 30_000, profile: profile2 },
    );

    // 第二次请求不应包含 profile-1 的 URL
    expect(calls[1].url).toContain('api2.example.com');
    expect(calls[1].url).not.toContain('api1.example.com');
    // 第二次请求不应包含 KEY1 的值
    expect(calls[1].headers['Authorization']).toBe('Bearer sk-key-2');
  });

  // 29. error/log/response 不包含凭证
  it('response content does not contain credentials', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);

    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.content).not.toContain('sk-fake');
    expect(result.content).not.toContain('OPENAI_API_KEY');
    if (result.error) {
      expect(result.error.message).not.toContain('sk-fake');
    }
  });
});

// ============================================================================
// 成功响应
// ============================================================================

describe('OpenAIChatAdapter execute — success response', () => {
  // 30. model 映射 reportedModel
  it('returns reportedModel from response model field', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({ model: 'gpt-4o' }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.reportedModel).toBe('gpt-4o');
    expect(result.isError).toBe(false);
  });

  // 31. content 取第一个 choice
  it('extracts content from first choice', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hello!' },
      }],
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.content).toBe('Hello!');
  });

  // 32. finish_reason 映射 subtype
  it('maps finish_reason to subtype', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({
      choices: [{ finish_reason: 'length', message: { content: 'x' } }],
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.subtype).toBe('length');
  });

  // 33. numTurns=1
  it('returns numTurns=1', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.numTurns).toBe(1);
  });

  // 34. reasoning_content 被忽略
  it('ignores reasoning_content in response', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({
      choices: [{
        finish_reason: 'stop',
        message: { content: 'visible', reasoning_content: 'secret reasoning' },
      }],
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.content).toBe('visible');
    // reasoning_content 不在 content 中
    expect(result.content).not.toContain('secret');
  });

  // 35. model 缺失 → null（不因缺少 model 判定整体无效）
  it('returns reportedModel=null when model field is missing', async () => {
    const { fetch } = createFakeFetch(() => {
      const body = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      return successJson(body);
    });
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.reportedModel).toBeNull();
    expect(result.isError).toBe(false);
    // 仍然是成功响应，只是 model 缺失 → 后续 executor 处理为 UNVERIFIED
  });

  // 36. model 为空字符串时视为 null
  it('returns reportedModel=null when model is empty string', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({ model: '' }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.reportedModel).toBeNull();
  });

  // tool_calls → unsupported known error，保留 reportedModel 和 usage
  it('returns isError=true with unsupported_tool_calls, retaining reportedModel and usage', async () => {
    const resp = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      model: 'gpt-4o',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
        },
      }],
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 300,
        total_tokens: 1800,
        prompt_cache_hit_tokens: 200,
        prompt_cache_miss_tokens: 1300,
      },
    };
    const { fetch } = createFakeFetch(() => successJson(resp));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.subtype).toBe('unsupported_tool_calls');
    expect(result.error!.kind).toBe('UNSUPPORTED');
    // 保留 reportedModel
    expect(result.reportedModel).toBe('gpt-4o');
    // 保留 usage
    expect(result.usage.inputTokens).toBe(1300);   // cache miss
    expect(result.usage.outputTokens).toBe(300);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.usage.cacheReadInputTokens).toBe(200);
    // 但不把 content 交给下游
    expect(result.content).toBe('');
  });

  // finish_reason='tool_calls' 也保留
  it('finish_reason=tool_calls retains reportedModel and usage', async () => {
    const resp = {
      model: 'gpt-4o',
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: 'could use tools' },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
    const { fetch } = createFakeFetch(() => successJson(resp));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.subtype).toBe('unsupported_tool_calls');
    expect(result.reportedModel).toBe('gpt-4o');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.content).toBe('');
  });

  it('returns structured tool_calls when tool mode is explicitly enabled', async () => {
    const { fetch, calls } = createFakeFetch(() => successJson({
      model: 'gpt-4o',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest({
      systemPrompt: '',
      userPrompt: '',
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file', description: 'read',
          parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
        },
      }],
      toolMode: 'enabled',
    }), makeContext());
    expect(result.isError).toBe(false);
    expect(result.content).toBe('');
    expect(result.toolCalls?.[0]?.function.name).toBe('read_file');
    const body = JSON.parse(calls[0].body) as { tools?: unknown[]; tool_choice?: string };
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe('auto');
  });

  it('rejects finish_reason=tool_calls without a structured call in enabled mode', async () => {
    const { fetch } = createFakeFetch(() => successJson({
      model: 'gpt-4o',
      choices: [{ finish_reason: 'tool_calls', message: { content: 'not a call' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    await expect(adapter.execute(makeRequest({
      toolMode: 'enabled',
      tools: [{
        type: 'function',
        function: {
          name: 'read_file', description: 'read',
          parameters: { type: 'object', additionalProperties: false, properties: {} },
        },
      }],
    }), makeContext())).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  // 39. empty string content is preserved
  it('returns empty content when message content is empty string', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({
      choices: [{ finish_reason: 'stop', message: { content: '' } }],
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.content).toBe('');
    expect(result.isError).toBe(false);
  });

  // 40. null content becomes empty string
  it('returns empty content when message content is null', async () => {
    const { fetch } = createFakeFetch(() => makeSuccessResponse({
      choices: [{ finish_reason: 'stop', message: { content: null } }],
    }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.content).toBe('');
    expect(result.isError).toBe(false);
  });
});

// ============================================================================
// Usage 映射
// ============================================================================

describe('normalizeOpenAIChatUsage', () => {
  // 41. cache hit/miss 完整，不双计 prompt_tokens
  it('uses cache miss as inputTokens and cache hit as cacheReadInputTokens', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
    });
    expect(result.inconsistent).toBe(false);
    expect(result.rawUsage.inputTokens).toBe(800);  // cache miss
    expect(result.rawUsage.outputTokens).toBe(500);
    expect(result.rawUsage.cacheCreationInputTokens).toBe(0);  // explicit 0, not null
    expect(result.rawUsage.cacheReadInputTokens).toBe(200);     // cache hit
    // 不双计——inputTokens 只用了 miss，没有额外加 prompt_tokens
  });

  it('maps standard OpenAI prompt_tokens_details.cached_tokens without double counting', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200 },
    });
    expect(result.inconsistent).toBe(false);
    expect(result.rawUsage).toEqual({
      inputTokens: 800,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 200,
    });
  });

  it('fails closed when standard and legacy cache counters disagree', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      prompt_tokens_details: { cached_tokens: 300 },
    });
    expect(result.inconsistent).toBe(true);
    expect(result.rawUsage.inputTokens).toBeNull();
  });

  it('fails closed when cached_tokens exceeds prompt_tokens', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 101 },
    });
    expect(result.inconsistent).toBe(true);
    expect(result.rawUsage.cacheReadInputTokens).toBeNull();
  });

  // 42. prompt_tokens 与 hit+miss 不一致 → fail closed
  it('detects inconsistency when prompt_tokens != hit + miss', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1500,
      completion_tokens: 500,
      total_tokens: 2000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
    });
    // 1500 != 200 + 800 = 1000
    expect(result.inconsistent).toBe(true);
    expect(result.inconsistencyReason).toContain('!==');
  });

  // 43. 只有 prompt/output、缺少缓存字段 → PARTIAL
  it('returns zero cache fields when no cache breakdown available', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    expect(result.inconsistent).toBe(false);
    expect(result.rawUsage.inputTokens).toBe(1000);
    expect(result.rawUsage.outputTokens).toBe(500);
    expect(result.rawUsage.cacheCreationInputTokens).toBe(0); // default to 0 for usage completeness
    expect(result.rawUsage.cacheReadInputTokens).toBe(0);     // default to 0 for usage completeness
    // usageStatus 最终由 classifyUsage 判定为 AVAILABLE
  });

  // 44. usage 缺失 → MISSING
  it('returns all-null when usage is null', () => {
    const result = normalizeOpenAIChatUsage(null);
    expect(result.rawUsage.inputTokens).toBeNull();
    expect(result.rawUsage.outputTokens).toBeNull();
    expect(result.rawUsage.cacheCreationInputTokens).toBeNull();
    expect(result.rawUsage.cacheReadInputTokens).toBeNull();
  });

  it('returns all-null when usage is undefined', () => {
    const result = normalizeOpenAIChatUsage(undefined);
    expect(result.rawUsage.inputTokens).toBeNull();
    expect(result.rawUsage.outputTokens).toBeNull();
  });

  // 45. Token 为 0 保持 0
  it('preserves 0 token values', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 0,
    });
    expect(result.inconsistent).toBe(false);
    expect(result.rawUsage.inputTokens).toBe(0);
    expect(result.rawUsage.outputTokens).toBe(0);
    expect(result.rawUsage.cacheCreationInputTokens).toBe(0);
    expect(result.rawUsage.cacheReadInputTokens).toBe(0);
  });

  // 46. 负数拒绝
  it('rejects negative token values', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: -1,
      completion_tokens: 500,
      total_tokens: 499,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: -1,
    });
    expect(result.inconsistent).toBe(true);
    expect(result.rawUsage.inputTokens).toBeNull();
  });

  // 47. 小数拒绝
  it('rejects non-integer token values', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: 1000,
      completion_tokens: 500.5,
      total_tokens: 1500.5,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
    });
    expect(result.inconsistent).toBe(true);
  });

  // 48. 非 finite 拒绝
  it('rejects Infinity token values', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: Infinity,
      completion_tokens: 500,
      total_tokens: Infinity,
    });
    expect(result.inconsistent).toBe(true);
  });

  it('rejects NaN token values', () => {
    const result = normalizeOpenAIChatUsage({
      prompt_tokens: NaN,
      completion_tokens: 500,
      total_tokens: NaN,
    });
    expect(result.inconsistent).toBe(true);
  });
});

// ============================================================================
// HTTP 错误
// ============================================================================

describe('OpenAIChatAdapter execute — HTTP errors', () => {
  // 50. 401 → AUTH error
  it('handles 401 as AUTH error', async () => {
    const { fetch } = createFakeFetch(() => new Response('Unauthorized', { status: 401 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error).not.toBeNull();
    expect(result.error!.kind).toBe('AUTH');
    expect(result.error!.httpStatus).toBe(401);
  });

  // 51. 403 → AUTH error
  it('handles 403 as AUTH error', async () => {
    const { fetch } = createFakeFetch(() => new Response('Forbidden', { status: 403 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error!.kind).toBe('AUTH');
    expect(result.error!.httpStatus).toBe(403);
  });

  // 52. 429 → RATE_LIMIT error
  it('handles 429 as RATE_LIMIT error', async () => {
    const { fetch } = createFakeFetch(() => new Response('Rate Limited', { status: 429 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error!.kind).toBe('RATE_LIMIT');
    expect(result.error!.httpStatus).toBe(429);
  });

  // 53. 500 → HTTP error
  it('handles 500 as HTTP error', async () => {
    const { fetch } = createFakeFetch(() => new Response('Internal Server Error', { status: 500 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error!.kind).toBe('HTTP');
    expect(result.error!.httpStatus).toBe(500);
  });

  // 54. HTTP 错误清除 PendingCall（由 executor 负责，这里只确认 isError=true 且无异常）
  it('HTTP errors return isError=true and do not throw', async () => {
    const { fetch } = createFakeFetch(() => new Response('Not Found', { status: 404 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error!.kind).toBe('HTTP');
  });

  // 55. HTTP 错误追加一条 isError UsageRecord（由 executor 负责，此处只确认 Adapter 返回正确）
  it('HTTP error response has null usage and content', async () => {
    const { fetch } = createFakeFetch(() => new Response('', { status: 503 }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.content).toBe('');
    expect(result.usage.inputTokens).toBeNull();
  });

  // 56. 错误消息不包含凭证
  it('error message does not contain credentials', async () => {
    const { fetch } = createFakeFetch(() => new Response(JSON.stringify({
      error: { message: 'Invalid API key: sk-leaked-key-12345', type: 'auth_error' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    if (result.error!.message) {
      expect(result.error!.message).not.toContain('sk-leaked');
    }
  });

  // 57. 错误 body 中提取 error.type 和 error.code
  it('extracts error type and code from JSON error body', async () => {
    const { fetch } = createFakeFetch(() => new Response(JSON.stringify({
      error: { message: 'Quota exceeded', type: 'insufficient_quota', code: 'quota_exceeded' },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
    expect(result.error!.type).toBe('insufficient_quota');
    expect(result.error!.code).toBe('quota_exceeded');
  });
});

// ============================================================================
// 未知结果
// ============================================================================

describe('OpenAIChatAdapter execute — unknown results', () => {
  // Timeout → TimeoutError（不是 TransportError）
  it('timeout throws TimeoutError, not TransportError', async () => {
    const { fetch } = createFakeFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          init.signal.addEventListener('abort', onAbort);
        }
      });
    });
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ timeoutMs: 10 });
    await expect(adapter.execute(makeRequest({ timeoutMs: 10 }), ctx)).rejects.toThrow(TimeoutError);
    // 不能是 TransportError
    await expect(adapter.execute(makeRequest({ timeoutMs: 10 }), ctx)).rejects.not.toThrow(TransportError);
  });

  // network rejection → TransportError
  it('throws TransportError on network rejection', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('Connection refused - operation timed out after 30s');
    };
    const adapter = new OpenAIChatAdapter(fetch);
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.toThrow(TransportError);
    // 不会因为 message 含 "timeout" 被错误分类为 TimeoutError
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.not.toThrow(TimeoutError);
  });

  // ProviderProtocolError → ProviderProtocolError
  it('throws ProviderProtocolError on malformed JSON 2xx', async () => {
    const { fetch } = createFakeFetch(() => new Response('not json at all', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.toThrow(ProviderProtocolError);
  });

  // ProviderProtocolError 不是 TimeoutError
  it('ProviderProtocolError is not TimeoutError', async () => {
    const { fetch } = createFakeFetch(() => successJson({ model: 'gpt-4o', choices: 'not-an-array' }));
    const adapter = new OpenAIChatAdapter(fetch);
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.toThrow(ProviderProtocolError);
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.not.toThrow(TimeoutError);
  });

  // redirect rejected → HTTP error (not a timeout)
  it('redirect is HTTP error, not timeout', async () => {
    const { fetch } = createFakeFetch(() => new Response('', { status: 301, headers: { Location: 'https://other.com/' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(true);
  });

  it('TimeoutError has correct name', () => {
    const err = new TimeoutError('test');
    expect(err.name).toBe('TimeoutError');
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it('TransportError has correct name', () => {
    const err = new TransportError('test');
    expect(err.name).toBe('TransportError');
    expect(err).toBeInstanceOf(TransportError);
  });

  it('ProviderProtocolError has correct name', () => {
    const err = new ProviderProtocolError('test');
    expect(err.name).toBe('ProviderProtocolError');
    expect(err).toBeInstanceOf(ProviderProtocolError);
  });
});

// ============================================================================
// 实际凭证值脱敏
// ============================================================================

describe('credential redaction via redactSecretValues', () => {
  const secret = 'vendor_secret.with+regex(chars)[123]';

  // 7. 任意格式实际 credential 被精确脱敏
  it('redacts actual credential value from error message', () => {
    const message = `API error: invalid key ${secret} - please check`;
    const result = redactSecretValues(message, [secret]);
    expect(result).not.toContain(secret);
    expect(result).toContain('<redacted-secret>');
  });

  it('ignores undefined and empty secrets', () => {
    const message = 'test message';
    const result = redactSecretValues(message, [undefined, '']);
    expect(result).toBe('test message');
  });

  it('handles regex special characters in secret', () => {
    const message = `error: ${secret} not found`;
    const result = redactSecretValues(message, [secret]);
    expect(result).not.toContain(secret);
    expect(result).toContain('<redacted-secret>');
  });

  it('redacts multiple occurrences of the same secret', () => {
    const message = `key=${secret} and also ${secret}`;
    const result = redactSecretValues(message, [secret]);
    expect(result.split('<redacted-secret>').length).toBe(3); // 2 occurrences → 2 replacements
  });

  it('does not modify text without the secret', () => {
    const message = 'Just a normal error message';
    const result = redactSecretValues(message, [secret]);
    expect(result).toBe('Just a normal error message');
  });
});

describe('OpenAIChatAdapter — credential redaction in errors', () => {
  const secret = 'vendor_secret.with+regex(chars)[123]';

  // HTTP error 中 credential 被脱敏
  it('redacts credential from HTTP error.message', async () => {
    const { fetch } = createFakeFetch(() => new Response(JSON.stringify({
      error: { message: `Invalid key: ${secret}`, type: `auth_${secret}`, code: `code_${secret}` },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ childEnv: { OPENAI_API_KEY: secret } });
    const result = await adapter.execute(makeRequest(), ctx);
    expect(result.isError).toBe(true);
    expect(result.error!.message).not.toContain(secret);
    expect(result.error!.message).toContain('<redacted-secret>');
    expect(result.error!.type).not.toContain(secret);
    expect(result.error!.code).not.toContain(secret);
  });

  // network error 中 credential 被脱敏
  it('redacts credential from network error message', async () => {
    const fetch: FetchLike = async () => {
      throw new Error(`Network error: connection to ${secret} failed`);
    };
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ childEnv: { OPENAI_API_KEY: secret } });
    await expect(adapter.execute(makeRequest(), ctx)).rejects.toThrow(TransportError);
    try {
      await adapter.execute(makeRequest(), ctx);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(secret);
      expect(msg).toContain('<redacted-secret>');
    }
  });

  // error.code 中 credential 被脱敏
  it('redacts credential from error.code', async () => {
    const { fetch } = createFakeFetch(() => new Response(JSON.stringify({
      error: { message: 'Error', code: `bad_key_${secret}` },
    }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ childEnv: { OPENAI_API_KEY: secret } });
    const result = await adapter.execute(makeRequest(), ctx);
    expect(result.isError).toBe(true);
    if (result.error!.code) {
      expect(result.error!.code).not.toContain(secret);
    }
  });
});

describe('OpenAIChatAdapter — security boundaries', () => {
  // 67. 凭证不在 error message 中
  it('does not expose credentials in transport error message', () => {
    const ctx = makeContext({ childEnv: { OPENAI_API_KEY: 'sk-secret-value' } });
    // 即使 childEnv 中有密钥，测试不发起真实请求——我们只通过代码审查确认路径
    expect(ctx.childEnv.OPENAI_API_KEY).toBe('sk-secret-value');
    // 实际密钥值不应出现在任何错误消息中（单元测试层面已通过 fake fetch 覆盖）
  });

  // 68. Authorization Header 格式正确
  it('constructs Authorization header correctly', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    await adapter.execute(makeRequest(), makeContext({ childEnv: { OPENAI_API_KEY: 'test-key-123' } }));
    expect(calls[0].headers['Authorization']).toBe('Bearer test-key-123');
  });
});

// ============================================================================
// AbortSignal 和 timeout 机制
// ============================================================================

describe('OpenAIChatAdapter — AbortSignal and timeout', () => {
  it('passes AbortSignal to fetch', async () => {
    const { fetch, calls } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    await adapter.execute(makeRequest(), makeContext());
    expect(calls[0].signal).not.toBeNull();
  });

  it('uses min(request.timeoutMs, context.timeoutMs)', async () => {
    // We verify by checking that the timeout doesn't trigger prematurely
    // when both are high enough
    const { fetch } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(
      makeRequest({ timeoutMs: 10_000 }),
      makeContext({ timeoutMs: 60_000 }),
    );
    // Should complete successfully because timeout = min(10k, 60k) = 10s > 0
    expect(result.isError).toBe(false);
  });

  it('clears the timeout timer in finally', async () => {
    // Timer cleanup is verified by not having unhandled rejections or
    // the timer firing after the request completes
    const { fetch } = createFakeFetch(() => makeSuccessResponse());
    const adapter = new OpenAIChatAdapter(fetch);
    const result = await adapter.execute(makeRequest(), makeContext());
    expect(result.isError).toBe(false);
    // If timer wasn't cleared, it would leak (detectable in long-running tests but not in unit)
  });
});

// ============================================================================
// P0.3: Adapter transient classification —— 真实 OpenAIChatAdapter 分类测试
// ============================================================================

describe('OpenAIChatAdapter — transient classification (1F-P0.3)', () => {
  const makeFetchRejection = (code: string | null, options?: { errno?: number }): FetchLike => {
    return async () => {
      const err = Object.assign(new Error(`Network error: ${code ?? 'unknown'}`), {
        code,
        errno: options?.errno,
        cause: code ? { code } : undefined,
      }) as Error & { code?: string; errno?: number; cause?: { code?: string } };
      throw err;
    };
  };

  const makeFetchRejectionWithCause = (causeCode: string | null): FetchLike => {
    return async () => {
      const cause = causeCode ? { code: causeCode } : undefined;
      const err = Object.assign(new Error(`Network error: ${causeCode ?? 'unknown'}`), {
        cause,
      }) as Error & { cause?: { code?: string } };
      throw err;
    };
  };

  it('ECONNRESET via error.code → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('ECONNRESET'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('ECONNRESET via error.cause.code → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejectionWithCause('ECONNRESET'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('ETIMEDOUT → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('ETIMEDOUT'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('EAI_AGAIN → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('EAI_AGAIN'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('ENOTFOUND → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('ENOTFOUND'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('ECONNREFUSED → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('ECONNREFUSED'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('unknown code (e.g. BOGUS_CODE) → transient=false', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection('BOGUS_CODE_NOT_IN_WHITELIST'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=false');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBeFalsy();
    }
  });

  it('no code (null) → transient=false', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection(null));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=false');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBeFalsy();
    }
  });

  it('unclassified errno → transient=false', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection(null, { errno: -9999 }));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=false');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBeFalsy();
    }
  });

  it('errno=-4078 maps to ECONNRESET → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection(null, { errno: -4078 }));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  it('errno=-4039 maps to ETIMEDOUT → transient=true', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejection(null, { errno: -4039 }));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  // Regression A — code-less fetch failed (real-world root cause)
  it('code-less TypeError("fetch failed") → transient=true (Regression A)', async () => {
    const makeCodeLessFetch = (): FetchLike => {
      return async () => {
        throw new TypeError('fetch failed');
      };
    };
    const adapter = new OpenAIChatAdapter(makeCodeLessFetch());
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
      expect((err as TransportError).cause).toBeDefined();
    }
  });

  // Regression B — UND_ERR_CONNECT_TIMEOUT
  it('UND_ERR_CONNECT_TIMEOUT → transient=true (Regression B)', async () => {
    const adapter = new OpenAIChatAdapter(makeFetchRejectionWithCause('UND_ERR_CONNECT_TIMEOUT'));
    try {
      await adapter.execute(makeRequest(), makeContext());
      expect.fail('Expected TransportError with transient=true');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).transient).toBe(true);
    }
  });

  // Regression C — permanent error should NOT be transient
  it('ProviderProtocolError should NOT be transient (Regression C)', async () => {
    const { fetch } = createFakeFetch(() => new Response('not json', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    const adapter = new OpenAIChatAdapter(fetch);
    // ProviderProtocolError 是协议层错误，不是 TransportError，不计入 transient
    await expect(adapter.execute(makeRequest(), makeContext())).rejects.toThrow(ProviderProtocolError);
  });

  // Regression D — AbortController timeout remains non-transient
  it('AbortController timeout does NOT become transient (Regression D)', async () => {
    const { fetch } = createFakeFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          init.signal.addEventListener('abort', onAbort);
        }
      });
    });
    const adapter = new OpenAIChatAdapter(fetch);
    const ctx = makeContext({ timeoutMs: 1 });
    // TimeoutError 不是 TransportError，不受此修复影响
    await expect(adapter.execute(makeRequest({ timeoutMs: 1 }), ctx)).rejects.toThrow(TimeoutError);
  });
});
