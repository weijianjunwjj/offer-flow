/**
 * V8-4 单岗位分析生产 Provider（OpenAI-compatible / DeepSeek）。
 *
 * 只复用 server/llm/provider 的非流式 chatCompletion；不使用 legacy analyzeJob、
 * 不使用 OFFER_FLOW_JSON、不使用 Markdown+JSON、不使用百分制 matchScore。
 * transport retry 显式关闭（retryMax: 0）：task attempt 与 transport 重试分层。
 *
 * 安全：不记录完整 Prompt / JD / rawText / API key；抛出的错误只含稳定语义，
 * 绝不把 Provider 响应正文放进 message。
 */
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../../llm/provider';
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from './provider';
import {
  JOB_MATCH_ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserMessage,
  buildAnalysisRepairMessage,
} from './analysisPrompt';

const PROVIDER_NAME = 'deepseek';
const ANALYSIS_MAX_TOKENS = 4096;
const ANALYSIS_TEMPERATURE = 0.1;

/**
 * 把 chatCompletion 的字符串错误映射为安全的 AnalysisProviderError。
 * 只提取 HTTP 状态码等稳定信号，绝不把响应正文/异常明文放进 message。
 * 若 signal 已中断，一律视为用户取消（优先于超时）。
 */
function mapProviderError(rawError: string, signal: AbortSignal | undefined): AnalysisProviderError {
  if (signal?.aborted) {
    return new AnalysisProviderError('CANCELLED_BY_USER', '分析已被用户取消');
  }
  if (rawError.includes('未配置')) {
    return new AnalysisProviderError('CONFIGURATION_ERROR', 'LLM 未配置：缺少 Provider 环境变量');
  }
  if (rawError.includes('超时')) {
    return new AnalysisProviderError('PROVIDER_TIMEOUT', 'Provider 调用超时');
  }
  const status = /HTTP (\d{3})/.exec(rawError)?.[1];
  if (status === '429') {
    return new AnalysisProviderError('PROVIDER_RATE_LIMIT', 'Provider 触发限流（HTTP 429）');
  }
  if (status !== undefined) {
    return new AnalysisProviderError('PROVIDER_NETWORK_ERROR', `Provider 返回错误状态（HTTP ${status}）`);
  }
  return new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 网络调用失败');
}

async function call(
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<AnalysisProviderCallResult> {
  const result = await chatCompletion(JOB_MATCH_ANALYSIS_SYSTEM_PROMPT, userMessage, {
    maxTokens: ANALYSIS_MAX_TOKENS,
    temperature: ANALYSIS_TEMPERATURE,
    retryMax: 0, // transport 重试关闭：重试语义属任务层。
    signal,
  });
  if (result.error !== undefined && result.error !== '') {
    throw mapProviderError(result.error, signal);
  }
  if (signal?.aborted) {
    throw new AnalysisProviderError('CANCELLED_BY_USER', '分析已被用户取消');
  }
  if (result.rawText === '') {
    throw new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 返回空内容');
  }
  return { rawText: result.rawText, provider: PROVIDER_NAME, model: result.model };
}

/** 生产 DeepSeek/OpenAI-compatible 分析 Provider（单例）。 */
export const deepSeekJobMatchAnalysisProvider: JobMatchAnalysisProvider = {
  isConfigured: isLlmConfigured,
  providerName: () => PROVIDER_NAME,
  modelName: () => getLlmConfig().model || 'unknown',
  generate(input, signal) {
    return call(buildAnalysisUserMessage(input), signal);
  },
  repair(input, previousRawText, validationSummary, signal) {
    return call(buildAnalysisRepairMessage(input, previousRawText, validationSummary), signal);
  },
};
