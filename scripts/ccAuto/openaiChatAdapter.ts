/** cc-auto v0.2.0 Slice 1C — OpenAI Chat Transport Adapter。
 *
 * 通过原生 fetch 调用 Profile 指定的 OpenAI Chat 兼容接口，并将响应标准化为 ProviderCallResponse。
 *
 * 安全边界：
 * - 不读取 process.env（凭证只从 context.childEnv 读取）
 * - 不在日志中输出 Authorization Header
 * - 不把凭证放入错误消息
 * - 不自动重试
 * - 不自动切换 Provider
 * - 不硬编码模型 ID
 * - 不实现 streaming / SSE
 * - 不安装额外 HTTP 依赖（使用 Node 原生 fetch）
 */
import { z } from 'zod';
import { TimeoutError, TransportError, ProviderProtocolError } from './providerErrors';
import { redactSecretValues } from './redact';
import { checkProfileEnvConflicts, formatEnvConflicts } from './envNamespace';
import type {
  ProviderAdapter,
  ProviderProfile,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderExecutionContext,
  RawProviderUsage,
  AdapterProfileValidationResult,
  ProviderResponseError,
  ProviderChatMessage,
  ModelToolCall,
} from './types';

// ============================================================================
// Fetch 注入
// ============================================================================

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// ============================================================================
// URL 构建
// ============================================================================

/**
 * 构建 OpenAI Chat Completions 完整 URL。
 *
 * 规则：
 * - 删除末尾多余 `/`
 * - 在现有路径后追加 `/chat/completions`
 * - 不接受已经含有 query、hash、username 或 password 的 URL
 */
export function buildChatCompletionsUrl(apiBaseUrl: string): URL {
  let base = apiBaseUrl.replace(/\/+$/, '');
  const full = `${base}/chat/completions`;
  const url = new URL(full);

  // 拒绝非 https
  if (url.protocol !== 'https:') {
    throw new TransportError(`buildChatCompletionsUrl: 仅允许 https URL，收到 ${url.protocol}`);
  }

  // 不允许 username/password
  if (url.username || url.password) {
    throw new TransportError('buildChatCompletionsUrl: URL 不允许包含 username/password');
  }

  // 不接受 query 和 hash——这些应在 Profile 的 apiBaseUrl 校验阶段拒绝
  // 此处做二次防御
  if (url.search || url.hash) {
    throw new TransportError('buildChatCompletionsUrl: URL 不允许包含 query 或 hash');
  }

  return url;
}

// ============================================================================
// 请求体构建
// ============================================================================

export interface OpenAIChatRequestBody {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
    /** DeepSeek reasoning_content——模型思考链，assistant 消息可选字段 */
    reasoning_content?: string | null;
  }>;
  max_tokens: number;
  stream: false;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: { type: 'object'; additionalProperties: false; required?: string[]; properties: Record<string, unknown> };
    };
  }>;
  tool_choice?: 'auto';
}

/**
 * 构建 OpenAI Chat 请求体。
 *
 * 兼容两种模式：
 * - 旧 prompt 模式：systemPrompt + userPrompt → [{role:'system'}, {role:'user'}]
 * - 新 messages 模式：request.messages → 序列化后发送
 * - 冲突时（messages 存在且 systemPrompt/userPrompt 非空）返回本地协议错误
 *
 * tool mode disabled（默认）：不发送 tools / tool_choice
 * tool mode enabled：发送 tools + tool_choice='auto'
 */
export function buildOpenAIChatRequestBody(request: ProviderCallRequest): OpenAIChatRequestBody {
  const toolMode = request.toolMode ?? 'disabled';
  const hasMessages = request.messages && request.messages.length > 0;
  const hasPrompt = request.systemPrompt.length > 0 || request.userPrompt.length > 0;

  // prompt/messages 冲突检测
  if (hasMessages && hasPrompt) {
    throw new TransportError(
      'buildOpenAIChatRequestBody: messages 和 systemPrompt/userPrompt 不能同时有效——prompt/messages 冲突',
    );
  }

  let messages: OpenAIChatRequestBody['messages'];

  if (hasMessages) {
    // messages 模式——序列化
    messages = serializeMessages(request.messages!);
  } else {
    // 旧 prompt 模式（向后兼容）
    messages = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];
  }

  const body: OpenAIChatRequestBody = {
    model: request.requestedModelId,
    messages,
    max_tokens: request.maxOutputTokens,
    stream: false,
  };

  // tool mode enabled：发送 tools + tool_choice
  if (toolMode === 'enabled') {
    if (!request.tools || request.tools.length === 0) {
      throw new TransportError(
        'buildOpenAIChatRequestBody: toolMode=enabled 但 tools 缺失或为空',
      );
    }
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }

  return body;
}

/**
 * 将 ProviderChatMessage[] 序列化为 OpenAI 消息格式。
 * - assistant + toolCalls → tool_calls 数组 + content（可为 null）
 * - tool → content（工具结果 JSON）+ tool_call_id
 */
function serializeMessages(
  msgs: ProviderChatMessage[],
): OpenAIChatRequestBody['messages'] {
  return msgs.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
        reasoning_content: m.reasoningContent ?? undefined,
      };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content: m.content,
        reasoning_content: m.reasoningContent ?? undefined,
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        content: m.content,
        tool_call_id: m.toolCallId,
      };
    }
    return {
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    };
  });
}

// ============================================================================
// 响应 Schema（最小兼容——只解析实际需要的字段）
// ============================================================================

const openaiChatUsageSchema = z.object({
  prompt_tokens: z.number().int().finite().nonnegative().nullable().optional(),
  completion_tokens: z.number().int().finite().nonnegative().nullable().optional(),
  total_tokens: z.number().int().finite().nonnegative().nullable().optional(),
  prompt_cache_hit_tokens: z.number().int().finite().nonnegative().nullable().optional(),
  prompt_cache_miss_tokens: z.number().int().finite().nonnegative().nullable().optional(),
});

const openaiChatResponseSchema = z.object({
  model: z.string().nullable().optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({
      content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      tool_calls: z.unknown().optional(),
    }).optional(),
  })).optional(),
  usage: openaiChatUsageSchema.nullable().optional(),
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.union([z.string(), z.number()]).nullable().optional(),
  }).optional(),
});

type ParsedOpenAIResponse = z.infer<typeof openaiChatResponseSchema>;

// ============================================================================
// Usage 映射
// ============================================================================

export interface OpenAIChatUsageResult {
  rawUsage: RawProviderUsage;
  /** true 表示映射过程中发现不可调和的不一致 */
  inconsistent: boolean;
  /** 不一致原因的摘要（仅在不一致时非空） */
  inconsistencyReason: string;
}

/**
 * 将 OpenAI Chat 兼容响应中的 usage 标准化为 RawProviderUsage。
 *
 * 保守映射规则：
 * - 同时存在 prompt_cache_hit_tokens 和 prompt_cache_miss_tokens 时：
 *   inputTokens = prompt_cache_miss_tokens（cache miss = 普通输入 Token）
 *   outputTokens = completion_tokens
 *   cacheCreationInputTokens = 0（OpenAI Chat 无 cache creation 概念）
 *   cacheReadInputTokens = prompt_cache_hit_tokens
 *   同时校验 prompt_tokens === hit + miss，不等则标记 inconsistent
 * - 只有 prompt_tokens + completion_tokens，无缓存细分：
 *   inputTokens = prompt_tokens
 *   outputTokens = completion_tokens
 *   cacheCreationInputTokens = null（Provider 未返回）
 *   cacheReadInputTokens = null（Provider 未返回）
 * - usage 完全缺失：全部 null
 * - 所有 Token 必须为非负整数，非法值拒绝
 */
export function normalizeOpenAIChatUsage(
  raw: ParsedOpenAIResponse['usage'],
): OpenAIChatUsageResult {
  // usage 整体缺失
  if (!raw) {
    return {
      rawUsage: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      inconsistent: false,
      inconsistencyReason: '',
    };
  }

  const hasCacheBreakdown =
    raw.prompt_cache_hit_tokens !== null &&
    raw.prompt_cache_hit_tokens !== undefined &&
    raw.prompt_cache_miss_tokens !== null &&
    raw.prompt_cache_miss_tokens !== undefined;

  if (hasCacheBreakdown) {
    // 校验 token 值合法性
    const hit = raw.prompt_cache_hit_tokens!;
    const miss = raw.prompt_cache_miss_tokens!;

    if (!isValidTokenValue(hit) || !isValidTokenValue(miss)) {
      return {
        rawUsage: {
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
        inconsistent: true,
        inconsistencyReason: `cache token 值非法：hit=${hit}, miss=${miss}`,
      };
    }

    // 检查不一致：prompt_tokens 应该等于 hit + miss
    if (raw.prompt_tokens !== null && raw.prompt_tokens !== undefined) {
      if (!isValidTokenValue(raw.prompt_tokens)) {
        return {
          rawUsage: {
            inputTokens: null,
            outputTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
          inconsistent: true,
          inconsistencyReason: `prompt_tokens 值非法：${raw.prompt_tokens}`,
        };
      }
      if (raw.prompt_tokens !== hit + miss) {
        return {
          rawUsage: {
            inputTokens: null,
            outputTokens: null,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
          inconsistent: true,
          inconsistencyReason:
            `prompt_tokens (${raw.prompt_tokens}) !== prompt_cache_hit_tokens (${hit}) + prompt_cache_miss_tokens (${miss})`,
        };
      }
    }

    const completionTokens = raw.completion_tokens ?? null;
    if (completionTokens !== null && !isValidTokenValue(completionTokens)) {
      return {
        rawUsage: {
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
        inconsistent: true,
        inconsistencyReason: `completion_tokens 值非法：${completionTokens}`,
      };
    }

    return {
      rawUsage: {
        inputTokens: miss,
        outputTokens: completionTokens,
        cacheCreationInputTokens: 0,  // OpenAI Chat 没有独立 cache creation 类别
        cacheReadInputTokens: hit,
      },
      inconsistent: false,
      inconsistencyReason: '',
    };
  }

  // 没有缓存细分——只用 prompt_tokens + completion_tokens
  const promptTokens = raw.prompt_tokens ?? null;
  const completionTokens = raw.completion_tokens ?? null;

  if (promptTokens !== null && !isValidTokenValue(promptTokens)) {
    return {
      rawUsage: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      inconsistent: true,
      inconsistencyReason: `prompt_tokens 值非法：${promptTokens}`,
    };
  }
  if (completionTokens !== null && !isValidTokenValue(completionTokens)) {
    return {
      rawUsage: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      inconsistent: true,
      inconsistencyReason: `completion_tokens 值非法：${completionTokens}`,
    };
  }

  return {
    rawUsage: {
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      cacheCreationInputTokens: null,  // Provider 未返回缓存细分
      cacheReadInputTokens: null,
    },
    inconsistent: false,
    inconsistencyReason: '',
  };
}

/** 校验 Token 值：必须是 number、finite、integer、>= 0 */
function isValidTokenValue(value: number | null | undefined): value is number {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'number') return false;
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return false;
  if (value < 0) return false;
  return true;
}

// ============================================================================
// OpenAIChatAdapter
// ============================================================================

/**
 * OpenAIChatAdapter —— 通过原生 fetch 调用 OpenAI Chat 兼容接口。
 *
 * 无状态设计：
 * - 不在构造函数中绑定具体业务 Profile
 * - 每次 execute 从 context.profile 读取配置
 * - 同一个 Adapter 实例可以安全执行多个不同 openai-chat Profile
 */
export class OpenAIChatAdapter implements ProviderAdapter {
  readonly transport = 'openai-chat' as const;

  private readonly _fetch: FetchLike;

  /**
   * @param fetchImpl 可注入的 fetch 实现，生产环境默认使用 globalThis.fetch
   */
  constructor(fetchImpl?: FetchLike) {
    this._fetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Profile 预校验 */
  validateProfile(profile: ProviderProfile): AdapterProfileValidationResult {
    // 1. transport 必须为 'openai-chat'
    if (profile.transport !== 'openai-chat') {
      return { ok: false, message: `transport 必须为 'openai-chat'，收到 "${profile.transport}"` };
    }

    // 2. apiBaseUrl 存在且非空
    if (!profile.apiBaseUrl || profile.apiBaseUrl.trim().length === 0) {
      return { ok: false, message: 'apiBaseUrl 必须存在且非空' };
    }

    // 3. URL 可被标准 URL 解析，仅允许 https
    let parsed: URL;
    try {
      parsed = new URL(profile.apiBaseUrl);
    } catch {
      return { ok: false, message: `apiBaseUrl 不是有效 URL：${profile.apiBaseUrl}` };
    }

    if (parsed.protocol !== 'https:') {
      return { ok: false, message: `apiBaseUrl 仅允许 https，收到 ${parsed.protocol}` };
    }

    // 4. URL 不允许 username/password
    if (parsed.username || parsed.password) {
      return { ok: false, message: 'apiBaseUrl 不允许包含 username/password' };
    }

    // 5. URL 不允许 query 和 hash
    if (parsed.search || parsed.hash) {
      return { ok: false, message: 'apiBaseUrl 不允许包含 query 或 hash' };
    }

    // 6. credentialEnvVars 必须恰好有一个 Bearer 凭证变量名
    if (!Array.isArray(profile.credentialEnvVars) || profile.credentialEnvVars.length !== 1) {
      return { ok: false, message: `credentialEnvVars 必须恰好包含 1 个 Bearer 凭证变量名，收到 ${profile.credentialEnvVars?.length ?? 0} 个` };
    }

    // 7. 环境变量命名空间冲突检查（大小写不敏感）
    const conflicts = checkProfileEnvConflicts(profile);
    if (conflicts.length > 0) {
      return { ok: false, message: `环境变量命名空间冲突：${formatEnvConflicts(conflicts)}` };
    }

    return { ok: true };
  }

  /**
   * 执行一次 OpenAI Chat 调用。
   *
   * 流程：构建 URL → 构建请求体 → 发送 fetch → 解析响应 → 标准化
   */
  async execute(
    request: ProviderCallRequest,
    context: ProviderExecutionContext,
  ): Promise<ProviderCallResponse> {
    const profile = context.profile;

    // 从 childEnv 读取 Bearer 凭证
    const credentialVarName = profile.credentialEnvVars[0];
    const credential = context.childEnv[credentialVarName];
    if (!credential) {
      // 凭证缺失是 Adapter 层面的 fail-closed——不创建 PendingCall
      // 但此检查重复 buildChildEnv 的校验，主要防御绕过 executor 直接调用 Adapter 的场景
      throw new TransportError(`凭证 "${credentialVarName}" 在 childEnv 中缺失`);
    }

    // 构建 URL
    const url = buildChatCompletionsUrl(profile.apiBaseUrl!);

    // 构建请求体
    const body = buildOpenAIChatRequestBody(request);

    // 计算有效 timeout（取 request.timeoutMs 和 context.timeoutMs 中较小者）
    const effectiveTimeoutMs = Math.min(request.timeoutMs, context.timeoutMs);

    // 创建 AbortController
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const response = await this._fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });

      // 处理非 2xx 响应
      if (!response.ok) {
        return this._handleHttpError(request, response, credential);
      }

      // 解析 2xx 响应
      return this._parseSuccessResponse(request, response, credential);
    } catch (err) {
      // AbortController 超时 → TimeoutError
      if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
        throw new TimeoutError(
          `OpenAI Chat 调用超时（${effectiveTimeoutMs}ms）：${url.toString()}`,
        );
      }

      // 已经是领域错误，直接抛出
      if (err instanceof TimeoutError || err instanceof TransportError || err instanceof ProviderProtocolError) {
        throw err;
      }

      // 其他网络错误（DNS/TLS/socket/rejection）→ TransportError
      // 根据 error.cause?.code 分类瞬时 vs 永久
      const code = getNetworkErrorCode(err);
      const transient = isTransientNetworkCode(code);
      throw new TransportError(
        redactSecretValues(`OpenAI Chat 网络错误：${(err as Error).message}`, [credential]),
        { transient },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 处理 HTTP 非 2xx 错误 */
  private async _handleHttpError(
    request: ProviderCallRequest,
    response: Response,
    credential: string,
  ): Promise<ProviderCallResponse> {
    const httpStatus = response.status;

    // 尝试从 body 中提取错误信息
    let errorBody: Record<string, unknown> = {};
    try {
      const text = await response.text();
      errorBody = safeParseJson(text);
    } catch {
      // 无法解析 body，使用默认错误
    }

    const rawMessage = typeof errorBody?.error === 'object' && errorBody.error !== null
      ? (errorBody.error as Record<string, unknown>)?.message
      : typeof errorBody?.message === 'string'
        ? errorBody.message
        : null;
    const rawType = typeof errorBody?.error === 'object' && errorBody.error !== null
      ? (errorBody.error as Record<string, unknown>)?.type
      : null;
    const rawCode = typeof errorBody?.error === 'object' && errorBody.error !== null
      ? (errorBody.error as Record<string, unknown>)?.code
      : null;

    // 分类
    const kind = classifyHttpError(httpStatus);

    // 基于实际凭证值脱敏所有错误字段
    const secrets = [credential];
    const safeMessage = redactSecretValues(
      sanitizeErrorMessage(typeof rawMessage === 'string' ? rawMessage : `HTTP ${httpStatus}`),
      secrets,
    );
    const safeType = typeof rawType === 'string'
      ? redactSecretValues(sanitizeErrorMessage(rawType), secrets)
      : null;
    const safeCode = rawCode !== null && rawCode !== undefined
      ? redactSecretValues(sanitizeErrorMessage(String(rawCode)), secrets)
      : null;

    const providerError: ProviderResponseError = {
      kind,
      httpStatus,
      code: safeCode,
      type: safeType,
      message: safeMessage,
    };

    return {
      callId: request.callId,
      providerId: request.providerId,
      requestedModelId: request.requestedModelId,
      reportedModel: null,
      content: '',
      usage: {
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      },
      durationMs: null,
      numTurns: 0,
      subtype: kind === 'AUTH' ? 'auth_error' : kind === 'RATE_LIMIT' ? 'rate_limit' : 'http_error',
      isError: true,
      error: providerError,
    };
  }

  /** 解析 2xx 成功响应 */
  private async _parseSuccessResponse(
    request: ProviderCallRequest,
    response: Response,
    credential: string,
  ): Promise<ProviderCallResponse> {
    let raw: unknown;
    try {
      const text = await response.text();
      raw = JSON.parse(text);
    } catch {
      throw new ProviderProtocolError('OpenAI Chat 响应 JSON 解析失败');
    }

    // Schema 解析
    const parsed = openaiChatResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderProtocolError(
        `OpenAI Chat 响应 Schema 不匹配：${parsed.error.message}`,
      );
    }

    const data = parsed.data;
    const respError = data.error;
    const secrets = [credential];

    // 2xx body 包含 error 对象（Provider 在 body 中返回错误）
    if (respError) {
      const kind = classifyHttpError(response.status);
      const safeMessage = redactSecretValues(
        sanitizeErrorMessage(typeof respError.message === 'string' ? respError.message : `HTTP ${response.status}`),
        secrets,
      );
      const safeType = typeof respError.type === 'string'
        ? redactSecretValues(sanitizeErrorMessage(respError.type), secrets)
        : null;
      const safeCode = respError.code !== null && respError.code !== undefined
        ? redactSecretValues(sanitizeErrorMessage(String(respError.code)), secrets)
        : null;

      const providerError: ProviderResponseError = {
        kind,
        httpStatus: response.status,
        code: safeCode,
        type: safeType,
        message: safeMessage,
      };

      return {
        callId: request.callId,
        providerId: request.providerId,
        requestedModelId: request.requestedModelId,
        reportedModel: null,
        content: '',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
        durationMs: null,
        numTurns: 0,
        subtype: 'error',
        isError: true,
        error: providerError,
      };
    }

    // 成功响应：提取字段
    const reportedModel = typeof data.model === 'string' && data.model.length > 0
      ? data.model
      : null;

    const firstChoice = data.choices?.[0];
    const rawContent = firstChoice?.message?.content;
    const effectiveContent: string | null =
      rawContent === null ? null : (typeof rawContent === 'string' ? rawContent : '');
    const finishReason = firstChoice?.finish_reason;
    const subtype = typeof finishReason === 'string'
      ? finishReason
      : 'unknown';

    // Usage 映射
    const usageResult = normalizeOpenAIChatUsage(data.usage ?? null);

    // Usage 不一致 → ProviderProtocolError
    if (usageResult.inconsistent) {
      throw new ProviderProtocolError(
        `OpenAI Chat Usage 不一致：${usageResult.inconsistencyReason}`,
      );
    }

    // 工具模式判定
    const toolMode = request.toolMode ?? 'disabled';
    const rawToolCalls = firstChoice?.message?.tool_calls;

    // === tool mode enabled：解析 tool_calls ===
    if (toolMode === 'enabled') {
      const parsed = parseToolCallsFromResponse(rawToolCalls, effectiveContent);
      if (!parsed.ok) {
        throw new ProviderProtocolError(parsed.message);
      }
      if (finishReason === 'tool_calls' && parsed.toolCalls.length === 0) {
        throw new ProviderProtocolError('finish_reason=tool_calls 但响应没有结构化 tool_calls');
      }

      return {
        callId: request.callId,
        providerId: request.providerId,
        requestedModelId: request.requestedModelId,
        reportedModel,
        content: effectiveContent ?? '',
        usage: usageResult.rawUsage,
        durationMs: null,
        numTurns: 1,
        subtype: parsed.toolCalls.length > 0 ? 'tool_calls' : subtype,
        isError: false,
        error: null,
        toolCalls: parsed.toolCalls,
        reasoningContent: firstChoice?.message?.reasoning_content ?? null,
      };
    }

    // === tool mode disabled（默认）：拒绝 tool_calls ===
    // 检查 tool_calls——本切片不支持，但保留 reportedModel、usage 和费用信息
    if (rawToolCalls !== undefined && rawToolCalls !== null) {
      const toolCallsArr = rawToolCalls;
      if (Array.isArray(toolCallsArr) && toolCallsArr.length > 0) {
        return {
          callId: request.callId,
          providerId: request.providerId,
          requestedModelId: request.requestedModelId,
          reportedModel,
          content: '',  // 不把工具调用内容交给正常下游
          usage: usageResult.rawUsage,  // 保留真实 Usage
          durationMs: null,
          numTurns: 1,
          subtype: 'unsupported_tool_calls',
          isError: true,
          error: {
            kind: 'UNSUPPORTED',
            httpStatus: response.status,
            code: null,
            type: null,
            message: 'Provider 返回了 tool_calls，当前切片不支持',
          },
        };
      }
    }

    // 检查 finish_reason=tool_calls（disabled 模式兜底）
    if (finishReason === 'tool_calls') {
      return {
        callId: request.callId,
        providerId: request.providerId,
        requestedModelId: request.requestedModelId,
        reportedModel,
        content: '',
        usage: usageResult.rawUsage,
        durationMs: null,
        numTurns: 1,
        subtype: 'unsupported_tool_calls',
        isError: true,
        error: {
          kind: 'UNSUPPORTED',
          httpStatus: response.status,
          code: null,
          type: null,
          message: 'Provider 返回 finish_reason=tool_calls，当前切片不支持',
        },
      };
    }

    return {
      callId: request.callId,
      providerId: request.providerId,
      requestedModelId: request.requestedModelId,
      reportedModel,
      content: effectiveContent ?? '',
      usage: usageResult.rawUsage,
      durationMs: null, // fetch 自身不提供精确耗时，由 executor 计算
      numTurns: 1,
      subtype,
      isError: false,
      error: null,
    };
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 解析 OpenAI 响应中的 tool_calls。
 *
 * 严格验证：
 * - 每项 id 必须是非空字符串
 * - id 不重复
 * - type 必须为 'function'
 * - function.name 非空字符串
 * - function.arguments 为字符串
 * - 无 content 且无 tool_calls → protocol error
 * - 不依赖 finish_reason 判断工具存在性
 */
function parseToolCallsFromResponse(
  raw: unknown,
  content: string | null,
): { ok: true; toolCalls: ModelToolCall[] } | { ok: false; message: string } {
  // 无 tool_calls
  if (raw === undefined || raw === null) {
    if (content === null) {
      return { ok: false, message: '无 content 且无 tool_calls——协议错误' };
    }
    return { ok: true, toolCalls: [] };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, message: 'tool_calls 必须是数组' };
  }

  if (raw.length === 0) {
    if (content === null) {
      return { ok: false, message: 'content 为 null 且 tool_calls 为空——协议错误' };
    }
    return { ok: true, toolCalls: [] };
  }

  const seen = new Set<string>();
  const result: ModelToolCall[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `tool_calls[${i}] 必须是非 null 对象` };
    }
    const tc = item as Record<string, unknown>;

    // id 校验
    if (typeof tc.id !== 'string' || tc.id.length === 0) {
      return { ok: false, message: `tool_calls[${i}] id 缺失或非字符串` };
    }
    if (seen.has(tc.id)) {
      return { ok: false, message: `tool_calls[${i}] id "${tc.id.slice(0, 32)}" 重复` };
    }
    seen.add(tc.id);

    // type 校验
    if (tc.type !== 'function') {
      return { ok: false, message: `tool_calls[${i}] type 必须为 'function'，收到 ${JSON.stringify(tc.type)}` };
    }

    // function 校验
    if (!tc.function || typeof tc.function !== 'object') {
      return { ok: false, message: `tool_calls[${i}] function 缺失` };
    }
    const fn = tc.function as Record<string, unknown>;

    if (typeof fn.name !== 'string' || fn.name.length === 0) {
      return { ok: false, message: `tool_calls[${i}] function.name 缺失` };
    }
    if (typeof fn.arguments !== 'string') {
      return { ok: false, message: `tool_calls[${i}] function.arguments 必须是字符串` };
    }

    result.push({
      id: tc.id as string,
      type: 'function',
      function: {
        name: fn.name as string,
        arguments: fn.arguments as string,
      },
    });
  }

  return { ok: true, toolCalls: result };
}

/** HTTP 状态码到错误类型的分类 */
function classifyHttpError(status: number): ProviderResponseError['kind'] {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  return 'HTTP';
}

/** 安全的 JSON 解析——解析失败不抛异常 */
function safeParseJson(text: string): Record<string, unknown> {
  try {
    const result = JSON.parse(text);
    if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

/** 脱敏错误消息：限制长度，移除可能泄露的信息 */
function sanitizeErrorMessage(message: string): string {
  // 限制长度
  const truncated = message.slice(0, 500);
  // 移除疑似 API key 模式
  return truncated
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '<redacted-key>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, 'Bearer <redacted>');
}

// ============================================================================
// 瞬时网络错误分类 — 基于 error.cause.code，不靠 message 模糊匹配
// ============================================================================

/** 已知瞬时网络错误码集合 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',     // 连接被对方重置
  'ETIMEDOUT',      // 连接超时
  'EAI_AGAIN',      // DNS 临时失败
  'ECONNREFUSED',   // 连接被拒绝（瞬时）
  'ENOTFOUND',      // DNS 解析临时失败
  'EPIPE',          // 管道损坏
  'ECONNABORTED',   // 连接中止
  'ENETDOWN',       // 网络不可用
  'ENETUNREACH',    // 网络不可达
  'EHOSTDOWN',      // 主机宕机
  'EHOSTUNREACH',   // 主机不可达
  'ENETRESET',      // 网络重置
  'UND_ERR_SOCKET', // undici socket 错误
]);

function getNetworkErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  // 1. error.cause.code
  if (e.cause && typeof e.cause === 'object') {
    const cause = e.cause as Record<string, unknown>;
    if (typeof cause.code === 'string') return cause.code;
  }
  // 2. error.code（Node 原生错误）
  if (typeof e.code === 'string') return e.code;
  // 3. errno 到 code 的保守映射
  if (typeof e.errno === 'number') {
    if (e.errno === -4078 || e.errno === -54) return 'ECONNRESET';
    if (e.errno === -4039 || e.errno === -60) return 'ETIMEDOUT';
    if (e.errno === -3008 || e.errno === -3000) return 'EAI_AGAIN';
    if (e.errno === -4073 || e.errno === -61) return 'ECONNREFUSED';
  }
  return null;
}

function isTransientNetworkCode(code: string | null): boolean {
  if (!code) return false;
  return TRANSIENT_NETWORK_CODES.has(code);
}
