interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

interface LlmCallResult {
  rawText: string;
  model: string;
  error?: string;
  /** OpenAI-compatible finish_reason（'stop' | 'length' | ...）；用于识别截断。缺省 null。 */
  finishReason?: string | null;
}

/**
 * 诊断回调载荷：仅供运维/调试脚本捕获**原始**响应字段映射（是否取错字段、是否截断、
 * content 是否为空但 reasoning_content 有内容）。含原始正文，**绝不**用于生产日志/错误，
 * 由调用方（调试脚本）自行落地到 gitignored 目录，绝不提交。
 */
export interface LlmRawResponseInfo {
  httpStatus: number;
  finishReason: string | null;
  contentLength: number;
  reasoningContentLength: number;
  content: string;
  reasoningContent: string;
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * transport 层最大重试次数（区分 transport retry 与任务 attempt）。
   * 未传时保持现有默认（读 OFFERFLOW_LLM_RETRY_MAX，默认 2）；
   * 显式传入时钳制到 [0,5]，V8-4 分析 Provider 显式传 0 关闭 transport 重试。
   */
  retryMax?: number;
  /**
   * 诊断回调（仅运维/调试脚本注入）：拿到解析后的**原始**响应字段映射。
   * 生产路径不传 → 零行为变化。含原始正文，绝不进生产日志/错误。
   */
  onRawResponse?: (info: LlmRawResponseInfo) => void;
  /**
   * 关闭 DeepSeek 推理模型的思维链（OpenAI 兼容 `thinking: { type: 'disabled' }`）。
   * 推理模型下 reasoning_content 与 content 共享 max_tokens，思维链会挤占答案预算导致
   * 截断（content 空 → JSON 非法）。岗位分析要结构化 JSON、不需要思维链，故显式关闭。
   * 缺省不传该字段 → 其它调用维持默认（enabled），零行为变化。
   */
  disableThinking?: boolean;
}

/** 解析 transport 重试上限：显式值优先（钳制 [0,5]），否则沿用环境默认。 */
function resolveMaxRetries(explicit: number | undefined): number {
  if (explicit !== undefined) return Math.max(0, Math.min(5, Math.trunc(explicit)));
  return readEnvInt('OFFERFLOW_LLM_RETRY_MAX', 2, 0, 5);
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
}

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readEnvFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseFloat(raw);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readConfig(): LlmConfig {
  const baseUrl =
    process.env.OFFERFLOW_LLM_BASE_URL ||
    process.env.DEEPSEEK_BASE_URL ||
    '';
  const apiKey =
    process.env.OFFERFLOW_LLM_API_KEY ||
    process.env.DEEPSEEK_API_KEY ||
    '';
  const model =
    process.env.OFFERFLOW_LLM_MODEL ||
    process.env.DEEPSEEK_MODEL ||
    '';

  return { baseUrl, apiKey, model };
}

export function getLlmConfig(): LlmConfig {
  return readConfig();
}

export function getMissingLlmConfigFields(): string[] {
  const config = readConfig();
  const missing: string[] = [];
  if (config.baseUrl === '') {
    missing.push('BASE_URL');
  }
  if (config.apiKey === '') {
    missing.push('API_KEY');
  }
  if (config.model === '') {
    missing.push('MODEL');
  }
  return missing;
}

export function isLlmConfigured(): boolean {
  return getMissingLlmConfigFields().length === 0;
}

function buildConfigErrorMessage(): string {
  const missing = getMissingLlmConfigFields();
  if (missing.length === 0) {
    return '';
  }
  return `LLM 未配置：缺少环境变量 ${missing.join(', ')}。请设置 OFFERFLOW_LLM_${missing.join(' / OFFERFLOW_LLM_')}（或对应的 DEEPSEEK_* 变量）`;
}

function isRetryableError(error: Error & { cause?: unknown }): boolean {
  const msg = error.message || '';
  if (msg.includes('Connect Timeout') || msg.includes('connect')) return true;
  if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) return true;
  if (msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) return true;
  if (msg.includes('fetch failed')) return true;
  if (error.name === 'AbortError') return false;
  return false;
}

function formatErrorDetail(error: Error & { cause?: unknown }): string {
  const causeMsg =
    error.cause instanceof Error
      ? error.cause.message
      : typeof error.cause === 'string'
        ? error.cause
        : '';
  return causeMsg ? ` (cause: ${causeMsg})` : '';
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeoutMs: number },
  startTime: number,
  attempt: number,
  maxRetries: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), init.timeoutMs);
  const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternal);
    const err = error as Error & { cause?: unknown };

    if (err.name === 'AbortError') {
      throw err;
    }

    if (attempt < maxRetries && isRetryableError(err)) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
      console.log('[llm] retry', { attempt: attempt + 1, maxRetries, delayMs: delay, error: err.message });
      await sleep(delay);
      return fetchWithRetry(url, init, startTime, attempt + 1, maxRetries, externalSignal);
    }

    throw err;
  }
}

interface BuildFetchOptionsResult {
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  messages: LlmMessage[];
  promptChars: number;
}

function resolveMaxTokens(explicit: number | undefined): number {
  const HARD_MIN = 800;
  const HARD_MAX = 8192;
  const clamp = (value: number): number => Math.max(HARD_MIN, Math.min(HARD_MAX, value));
  if (explicit !== undefined) return clamp(explicit);
  return readEnvInt('OFFERFLOW_LLM_MAX_TOKENS', 1800, HARD_MIN, HARD_MAX);
}

function buildFetchOptions(
  systemPrompt: string,
  userMessage: string,
  options: LlmOptions | undefined,
): BuildFetchOptionsResult {
  const maxTokens = resolveMaxTokens(options?.maxTokens);
  const temperature = readEnvFloat('OFFERFLOW_LLM_TEMPERATURE', options?.temperature ?? 0.2, 0, 1);
  const timeoutMs = readEnvInt('OFFERFLOW_LLM_TIMEOUT_MS', options?.timeoutMs ?? 30000, 5000, 60000);

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  const promptChars = systemPrompt.length + userMessage.length;

  return { maxTokens, temperature, timeoutMs, messages, promptChars };
}

/**
 * 组装 chat/completions 请求体。disableThinking=true 时加 OpenAI 兼容
 * `thinking: { type: 'disabled' }` 关闭 DeepSeek 推理模型思维链；缺省不加该字段。
 * stream 由调用方按需附加，避免两处 body 分叉。
 */
function buildRequestBody(
  config: LlmConfig,
  messages: LlmMessage[],
  temperature: number,
  maxTokens: number,
  options: LlmOptions | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (options?.disableThinking === true) {
    body.thinking = { type: 'disabled' };
  }
  return body;
}

export async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
  options?: LlmOptions,
): Promise<LlmCallResult> {
  const config = readConfig();

  if (!isLlmConfigured()) {
    return {
      rawText: '',
      model: config.model || 'unknown',
      error: buildConfigErrorMessage(),
    };
  }

  const { maxTokens, temperature, timeoutMs, messages, promptChars } = buildFetchOptions(
    systemPrompt,
    userMessage,
    options,
  );

  const startTime = Date.now();
  const maxRetries = resolveMaxRetries(options?.retryMax);

  console.log('[llm] request start', {
    model: config.model,
    promptChars,
    maxTokens,
  });

  try {
    const fetchStart = Date.now();
    const response = await fetchWithRetry(
      `${config.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(config, messages, temperature, maxTokens, options)),
        timeoutMs,
      },
      startTime,
      0,
      maxRetries,
      options?.signal,
    );

    const upstreamElapsed = Date.now() - fetchStart;

    if (!response.ok) {
      const errorText = await response.text();
      console.log('[llm] upstream responded', { status: response.status, elapsedMs: upstreamElapsed });
      const totalElapsed = Date.now() - startTime;
      console.log('[llm] done', { elapsedMs: totalElapsed, rawTextChars: 0 });
      return {
        rawText: '',
        model: config.model,
        error: `LLM 调用失败 (HTTP ${response.status}): ${errorText}`,
      };
    }

    console.log('[llm] upstream responded', { status: response.status, elapsedMs: upstreamElapsed });

    const data = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
        finish_reason?: string;
      }>;
    };

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoningContent = choice?.message?.reasoning_content ?? '';
    const finishReason = choice?.finish_reason ?? null;
    const totalElapsed = Date.now() - startTime;

    // 诊断回调：仅调试脚本注入；含原始正文，绝不进生产日志。
    options?.onRawResponse?.({
      httpStatus: response.status,
      finishReason,
      contentLength: content.length,
      reasoningContentLength: reasoningContent.length,
      content,
      reasoningContent,
    });

    // 稳定诊断字段：不含正文，可安全进日志。finishReason='length' 即被 max_tokens 截断。
    console.log('[llm] done', {
      elapsedMs: totalElapsed,
      rawTextChars: content.length,
      finishReason,
    });

    if (content === '') {
      return {
        rawText: '',
        model: config.model,
        error: 'LLM 返回空内容',
        finishReason,
      };
    }

    return {
      rawText: content,
      model: config.model,
      finishReason,
    };
  } catch (error) {
    const totalElapsed = Date.now() - startTime;
    const err = error as Error & { cause?: unknown };

    if (err.name === 'AbortError') {
      console.log('[llm] done', { elapsedMs: totalElapsed, rawTextChars: 0, error: 'timeout' });
      return {
        rawText: '',
        model: config.model,
        error: 'LLM 调用超时，请稍后重试或缩短 JD / Prompt',
      };
    }

    const detail = formatErrorDetail(err);
    console.log('[llm] done', {
      elapsedMs: totalElapsed,
      rawTextChars: 0,
      error: 'exception',
      message: err.message,
      cause: detail || undefined,
    });
    return {
      rawText: '',
      model: config.model,
      error: `LLM 调用异常: ${err.message}${detail}`,
    };
  }
}

export async function* chatCompletionStream(
  systemPrompt: string,
  userMessage: string,
  options?: LlmOptions,
): AsyncGenerator<LlmStreamChunk, LlmCallResult> {
  const config = readConfig();

  if (!isLlmConfigured()) {
    const errorResult: LlmCallResult = {
      rawText: '',
      model: config.model || 'unknown',
      error: buildConfigErrorMessage(),
    };
    return errorResult;
  }

  const { maxTokens, temperature, timeoutMs, messages, promptChars } = buildFetchOptions(
    systemPrompt,
    userMessage,
    options,
  );

  const startTime = Date.now();
  const maxRetries = resolveMaxRetries(options?.retryMax);

  console.log('[llm] stream start', {
    model: config.model,
    promptChars,
    maxTokens,
  });

  const fetchStart = Date.now();
  let response: Response;
  try {
    response = await fetchWithRetry(
      `${config.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ ...buildRequestBody(config, messages, temperature, maxTokens, options), stream: true }),
        timeoutMs,
      },
      startTime,
      0,
      maxRetries,
      options?.signal,
    );
  } catch (error) {
    const totalElapsed = Date.now() - startTime;
    const err = error as Error & { cause?: unknown };

    if (err.name === 'AbortError') {
      console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: 0, error: 'timeout' });
      const errorResult: LlmCallResult = {
        rawText: '',
        model: config.model,
        error: 'LLM 调用超时，请稍后重试或缩短 JD / Prompt',
      };
      return errorResult;
    }

    const detail = formatErrorDetail(err);
    console.log('[llm] stream done', {
      elapsedMs: totalElapsed,
      rawTextChars: 0,
      error: 'exception',
      message: err.message,
      cause: detail || undefined,
    });
    const errorResult: LlmCallResult = {
      rawText: '',
      model: config.model,
      error: `LLM 调用异常: ${err.message}${detail}`,
    };
    return errorResult;
  }

  const upstreamResponseElapsed = Date.now() - fetchStart;

  if (!response.ok) {
    const errorText = await response.text();
    console.log('[llm] stream responded', { status: response.status, elapsedMs: upstreamResponseElapsed });
    const totalElapsed = Date.now() - startTime;
    console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: 0 });
    const errorResult: LlmCallResult = {
      rawText: '',
      model: config.model,
      error: `LLM 调用失败 (HTTP ${response.status}): ${errorText}`,
    };
    return errorResult;
  }

  console.log('[llm] stream responded', { status: response.status, elapsedMs: upstreamResponseElapsed });

  const reader = response.body?.getReader();
  if (!reader) {
    const totalElapsed = Date.now() - startTime;
    console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: 0, error: 'no body' });
    const errorResult: LlmCallResult = {
      rawText: '',
      model: config.model,
      error: 'LLM 返回空响应体',
    };
    return errorResult;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          const totalElapsed = Date.now() - startTime;
          console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: fullContent.length });
          const successResult: LlmCallResult = {
            rawText: fullContent,
            model: config.model,
          };
          return successResult;
        }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const chunk = parsed.choices?.[0]?.delta?.content ?? '';
          if (chunk) {
            fullContent += chunk;
            yield { content: chunk, done: false };
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    const totalElapsed = Date.now() - startTime;
    console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: fullContent.length });
    if (fullContent === '') {
      const errorResult: LlmCallResult = {
        rawText: '',
        model: config.model,
        error: 'LLM 返回空内容',
      };
      return errorResult;
    }
    const successResult: LlmCallResult = {
      rawText: fullContent,
      model: config.model,
    };
    return successResult;
  } catch (error) {
    const totalElapsed = Date.now() - startTime;
    const err = error as Error;
    console.log('[llm] stream done', { elapsedMs: totalElapsed, rawTextChars: fullContent.length, error: 'stream read error' });

    if (fullContent !== '') {
      const partialResult: LlmCallResult = {
        rawText: fullContent,
        model: config.model,
        error: `流式读取中断: ${err.message}`,
      };
      return partialResult;
    }

    const errorResult: LlmCallResult = {
      rawText: '',
      model: config.model,
      error: `LLM 调用异常: ${err.message}`,
    };
    return errorResult;
  }
}
