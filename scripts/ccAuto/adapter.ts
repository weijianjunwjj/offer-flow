/** cc-auto v0.2.0 Slice 1B — Provider Adapter 契约与 Mock Transport 实现。
 *
 * Provider Adapter 接口定义在 types.ts（ProviderAdapter）。
 * 本模块提供：
 * - MockProviderAdapter：可配置场景的 mock transport
 * - AdapterRegistry：transport → Adapter 的注册与选择
 * - 不根据 vendor 选择 Adapter
 * - 未实现 transport 返回 TRANSPORT_NOT_IMPLEMENTED
 */
import type {
  ProviderAdapter,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderExecutionContext,
  ProviderProfile,
  MockProviderScenario,
  AdapterProfileValidationResult,
} from './types';
import { TimeoutError } from './providerErrors';

/** Mock 场景对应的标准化响应生成器 */
const SCENARIO_RESPONSES: Record<
  MockProviderScenario,
  (request: ProviderCallRequest) => ProviderCallResponse
> = {
  VERIFIED_SUCCESS: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: req.requestedModelId,
    content: `[mock] VERIFIED_SUCCESS — 这是来自 mock transport 的模拟成功响应。任务：${req.userPrompt.slice(0, 50)}...`,
    usage: {
      inputTokens: 1500,
      outputTokens: 800,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 200,
    },
    durationMs: 1200,
    numTurns: 3,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  MISMATCH_MODEL: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: 'gpt-4-unknown',
    content: '[mock] MISMATCH_MODEL — 返回了一个不在白名单中的模型名',
    usage: {
      inputTokens: 1000,
      outputTokens: 400,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    durationMs: 800,
    numTurns: 2,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  UNVERIFIED_MODEL: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: null,
    content: '[mock] UNVERIFIED_MODEL — Provider 未返回实际模型 ID',
    usage: {
      inputTokens: 1200,
      outputTokens: 600,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    durationMs: 900,
    numTurns: 3,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  USAGE_MISSING: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: req.requestedModelId,
    content: '[mock] USAGE_MISSING — 所有 usage 字段均为 null',
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    durationMs: 700,
    numTurns: 2,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  USAGE_PARTIAL: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: req.requestedModelId,
    content: '[mock] USAGE_PARTIAL — 部分 usage 字段缺失',
    usage: {
      inputTokens: 2000,
      outputTokens: null,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: null,
    },
    durationMs: 950,
    numTurns: 4,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  UNPRICED_REPORTED_MODEL: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: 'deepseek-v3',
    content: '[mock] UNPRICED_REPORTED_MODEL — reportedModel 在白名单但不在 pricing 表中（VERIFIED 但 UNPRICED）',
    usage: {
      inputTokens: 1800,
      outputTokens: 900,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100,
    },
    durationMs: 1100,
    numTurns: 5,
    subtype: 'success',
    isError: false,
    error: null,
  }),

  PROVIDER_ERROR: (req) => ({
    callId: req.callId,
    providerId: req.providerId,
    requestedModelId: req.requestedModelId,
    reportedModel: null,
    content: '',
    usage: {
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    },
    durationMs: 300,
    numTurns: 0,
    subtype: 'error',
    isError: true,
    error: {
      kind: 'HTTP',
      httpStatus: 500,
      code: null,
      type: null,
      message: '[mock] Provider 返回 500 错误',
    },
  }),

  TIMEOUT: (_req) => {
    // TIMEOUT 场景由 Adapter 显式处理，不创建响应
    throw new TimeoutError('Mock timeout');
  },
};

export { TimeoutError } from './providerErrors';

/**
 * MockProviderAdapter — 完全离线，不发起任何网络请求。
 *
 * 注入 clock（可选）用于测试 TIMEOUT 场景，避免真实等待。
 */
export class MockProviderAdapter implements ProviderAdapter {
  readonly transport = 'openai-chat' as const; // mock 仅对接 openai-chat 形态
  readonly qualificationContract = {
    adapterId: 'mock-openai-chat-adapter',
    adapterContractVersion: 'mock-openai-chat-adapter-v1',
    toolCallTranslationVersion: 'mock-openai-chat-tool-call-translation-v1',
  } as const;

  private _scenario: MockProviderScenario;

  constructor(scenario: MockProviderScenario = 'VERIFIED_SUCCESS', _clock?: { now: () => number }) {
    this._scenario = scenario;
    // _clock 预留用于可控 fake timer 测试，当前未使用
    void _clock;
  }

  /** 动态切换场景（仅用于测试） */
  setScenario(scenario: MockProviderScenario): void {
    this._scenario = scenario;
  }

  /** 获取当前场景 */
  get scenario(): MockProviderScenario {
    return this._scenario;
  }

  /** Mock 预校验直接通过 */
  validateProfile(_profile: ProviderProfile): AdapterProfileValidationResult {
    return { ok: true };
  }

  async execute(
    request: ProviderCallRequest,
    _context: ProviderExecutionContext,
  ): Promise<ProviderCallResponse> {
    // 不读取任何 API Key / credential
    // 不访问网络
    // 不启动子进程

    const factory = SCENARIO_RESPONSES[this._scenario];
    try {
      return factory(request);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw err;
      }
      throw new Error(`MockProviderAdapter 内部错误：${(err as Error).message}`);
    }
  }
}

/**
 * AdapterRegistry — 根据 transport 选择 Adapter。
 * 不根据 vendor 选择；未注册 transport 返回 TRANSPORT_NOT_IMPLEMENTED。
 */
export class AdapterRegistry {
  private readonly _adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this._adapters.has(adapter.transport)) {
      throw new Error(
        `AdapterRegistry: transport "${adapter.transport}" 已注册——重复注册将覆盖，拒绝。` +
        `请检查生产 Registry 是否误注册了 mock adapter。`,
      );
    }
    this._adapters.set(adapter.transport, adapter);
  }

  resolve(transport: string): ProviderAdapter | null {
    return this._adapters.get(transport) ?? null;
  }

  get registeredTransports(): string[] {
    return [...this._adapters.keys()];
  }
}

/** 便利工厂：创建预注册了 MockProviderAdapter 的 Registry */
export function createMockAdapterRegistry(scenario?: MockProviderScenario, clock?: { now: () => number }): {
  registry: AdapterRegistry;
  adapter: MockProviderAdapter;
} {
  const registry = new AdapterRegistry();
  const adapter = new MockProviderAdapter(scenario, clock);
  registry.register(adapter);
  return { registry, adapter };
}
