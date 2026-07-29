/**
 * 运维脚本专用：把「瞬时网络 flake」的有界自动重试包在 Provider 外层。
 * 只在脚本这层重试；生产 provider 的 retryMax 仍为 0，且**不消耗任务 attempt 预算**
 * （一次 runTask 尝试内部穿越 flake）。绝不重试确定性失败。
 */
import { AnalysisProviderError, type JobMatchAnalysisProvider } from '../server/radar/analysis/provider';

/**
 * 是否为「瞬时网络 flake」——仅指连接层未拿到任何模型响应的抖动（connect timeout /
 * fetch failed / 网络调用失败 / 调用超时），重试才有意义。**绝不**判定为 flake：
 * finish_reason=length 截断、返回空内容、HTTP 4xx/5xx、限流、配置错误、用户取消、
 * 结构/敏感内容类错误——这些重试无用或语义不对，必须原样冒泡。
 */
export function isTransientFlake(err: unknown): boolean {
  if (!(err instanceof AnalysisProviderError)) return false;
  if (err.code !== 'PROVIDER_NETWORK_ERROR' && err.code !== 'PROVIDER_TIMEOUT') return false;
  if (err.detail === 'finish_reason=length') return false; // 截断：确定性预算问题
  const m = err.message;
  if (m.includes('空内容') || m.includes('HTTP ')) return false; // 空响应 / 明确状态码：非 flake
  return (
    err.code === 'PROVIDER_TIMEOUT' ||
    m.includes('网络调用失败') ||
    m.includes('Connect Timeout') ||
    m.includes('fetch failed')
  );
}

/**
 * 用有界自动重试包装 Provider。仅对 isTransientFlake 生效；其余错误立即冒泡。
 * retries=0 时等价于不包装。onRetry 便于测试/日志观测（可选）。
 */
export function withFlakeRetry(
  inner: JobMatchAnalysisProvider,
  retries: number,
  onRetry?: (phase: string, attempt: number, err: unknown) => void,
): JobMatchAnalysisProvider {
  async function run<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isTransientFlake(err) || attempt === retries) throw err;
        onRetry?.(phase, attempt + 1, err);
      }
    }
    throw lastErr; // 不可达（循环内必 return 或 throw），仅为类型完备。
  }
  return {
    isConfigured: inner.isConfigured,
    providerName: inner.providerName,
    modelName: inner.modelName,
    generate: (input, signal) => run('generate', () => inner.generate(input, signal)),
    repair: (input, prev, summary, signal) => run('repair', () => inner.repair(input, prev, summary, signal)),
  };
}
