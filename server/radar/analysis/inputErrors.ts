/**
 * V8-4 单岗位分析 · 输入组装错误（inputSnapshot / llmInput 组装阶段）。
 *
 * 与契约层错误（contractErrors.ts）、任务领域错误（errors.ts）分离：
 * 本类是**从数据库读取真实正式数据、组装快照/LLM 输入**时的前置校验错误
 * （候选不存在 / 不可分析 / 缺正式画像与简历 / 岗位事实不足以分析等）。
 *
 * 安全边界：message 仅承载稳定语义与字段名，绝不回显 JD 全文 / 简历原文 / 内部 ID 明文。
 */
export const ANALYSIS_INPUT_ERROR_CODES = [
  'CANDIDATE_NOT_FOUND',
  'CANDIDATE_VERSION_NOT_FOUND',
  'CANDIDATE_VERSION_MISMATCH',
  'CANDIDATE_NOT_ANALYZABLE',
  'ACTIVE_RESUME_REQUIRED',
  'ACTIVE_PROFILE_REQUIRED',
  'INPUT_NOT_READY',
] as const;
export type AnalysisInputErrorCode = (typeof ANALYSIS_INPUT_ERROR_CODES)[number];

export class AnalysisInputError extends Error {
  constructor(
    readonly code: AnalysisInputErrorCode,
    message: string,
    /** 仅稳定字段路径等安全定位信息，不含敏感值。 */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AnalysisInputError';
  }
}
