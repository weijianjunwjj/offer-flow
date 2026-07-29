/**
 * V8-4 单岗位分析 Provider 抽象 + 安全错误类型。
 *
 * 本波次只定义"生成 + 一次结构修复"的模型交互边界，不创建任务、不写数据库、不注册路由。
 * Provider 只返回原始文本与 provider/model 元数据；解析、交叉验证与 Envelope 由上层负责。
 *
 * 安全边界：AnalysisProviderError.message 只允许稳定语义描述，
 * **绝不**回显 rawText 全文、Prompt、JD、Token、API key 或 Provider 响应正文。
 */
import type { JobMatchAnalysisLlmInputV1 } from './llmContracts';
import type { AnalysisValidationIssue } from './contractErrors';

/** Provider / 编排层安全错误码（终态可映射为任务 error_code）。 */
export const ANALYSIS_PROVIDER_ERROR_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_NETWORK_ERROR',
  'PROVIDER_RATE_LIMIT',
  'CONFIGURATION_ERROR',
  'SCHEMA_INVALID',
  'STRUCTURE_REPAIR_FAILED',
  'CANCELLED_BY_USER',
  'SENSITIVE_CONTENT_LEAK',
  'INTERNAL_ID_LEAK',
] as const;
export type AnalysisProviderErrorCode = (typeof ANALYSIS_PROVIDER_ERROR_CODES)[number];

export class AnalysisProviderError extends Error {
  constructor(
    readonly code: AnalysisProviderErrorCode,
    message: string,
    /** 仅稳定的字段路径 / evidenceKey 等安全定位信息，不含敏感值。 */
    readonly detail?: string,
    /**
     * 脱敏结构化校验问题清单（结构/校验类错误专用）。
     * 用于在任务失败时持久化“具体失败摘要”，替代泛化的“结构修复失败”。
     */
    readonly issues?: readonly AnalysisValidationIssue[],
  ) {
    super(message);
    this.name = 'AnalysisProviderError';
  }
}

/** Provider 单次调用产物：仅原始文本与元数据，不含解析结果。 */
export interface AnalysisProviderCallResult {
  rawText: string;
  provider: string;
  model: string;
}

/**
 * 单岗位分析 Provider：首次生成 + 一次结构修复两个动作。
 * 两者都必须支持 AbortSignal 主动中断；transport 层不做 task attempt 级重试
 * （retry 语义属于任务层，本层显式关闭）。
 */
export interface JobMatchAnalysisProvider {
  isConfigured(): boolean;
  providerName(): string;
  modelName(): string;

  /** 首次生成：把脱敏 LLM 输入发给模型，返回原始文本。 */
  generate(
    input: JobMatchAnalysisLlmInputV1,
    signal?: AbortSignal,
  ): Promise<AnalysisProviderCallResult>;

  /**
   * 一次结构修复：附上一轮原始文本与**安全截断**的校验摘要，要求模型仅修结构。
   * 使用与首次相同的 LLM 输入，不引入新事实。
   */
  repair(
    input: JobMatchAnalysisLlmInputV1,
    previousRawText: string,
    validationSummary: string,
    signal?: AbortSignal,
  ): Promise<AnalysisProviderCallResult>;
}
