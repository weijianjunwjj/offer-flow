/**
 * V8-4 单岗位分析契约错误（Snapshot / LLM 输入 / 证据目录 / 输出 Payload）。
 *
 * 与任务领域错误（analysis/errors.ts）分离：那是状态机/Repository 的错误，
 * 这是**契约与解析层**错误。本波次不注册路由，不做 HTTP 映射。
 *
 * 安全边界：错误 message 只允许稳定的语义描述与字段路径，
 * **绝不**回显 rawText 全文、snapshot 全文、JD、Prompt、Token 或 Provider 原始响应。
 */
export const ANALYSIS_CONTRACT_ERROR_CODES = [
  // —— Snapshot ——
  'SNAPSHOT_INVALID',
  'SNAPSHOT_TOO_LARGE',
  // —— LLM 输入 ——
  'LLM_INPUT_INVALID',
  'LLM_INPUT_INTERNAL_ID_LEAK',
  'LLM_INPUT_SENSITIVE_CONTENT',
  // —— 证据目录 ——
  'EVIDENCE_KEY_INVALID',
  'EVIDENCE_DUPLICATE_KEY',
  'EVIDENCE_TOO_MANY',
  // —— 输出 Payload（解析/交叉验证）——
  'ANALYSIS_JSON_INVALID',
  'ANALYSIS_SCHEMA_INVALID',
  'ANALYSIS_PAYLOAD_TOO_LARGE',
  'ANALYSIS_UNKNOWN_EVIDENCE_KEY',
  'ANALYSIS_SENSITIVE_CONTENT',
  'ANALYSIS_INTERNAL_ID_LEAK',
  'ANALYSIS_HTML_NOT_ALLOWED',
] as const;
export type AnalysisContractErrorCode = (typeof ANALYSIS_CONTRACT_ERROR_CODES)[number];

/**
 * 单条脱敏校验问题：只承载稳定的字段路径与稳定语义码/文案，
 * **绝不**包含模型 received 值、rawText 片段、JSON 明文或敏感内容。
 * 供 repair prompt 精确定位与失败摘要持久化使用。
 */
export interface AnalysisValidationIssue {
  /** 字段路径（点连接，例 'dimensions.roleFit.points.0.kind'）；顶层为空串。 */
  path: string;
  /** 稳定语义码（Zod issue code 或自定义码，例 'invalid_type' / 'unrecognized_keys'）。 */
  code: string;
  /** 稳定语义文案（不含 received 值），已截断。 */
  message: string;
}

export class AnalysisContractError extends Error {
  constructor(
    readonly code: AnalysisContractErrorCode,
    message: string,
    /** 仅稳定的字段路径等安全定位信息，不含敏感值。 */
    readonly detail?: string,
    /** 结构化脱敏校验问题清单（Zod/交叉校验），用于精确修复与失败摘要。 */
    readonly issues?: readonly AnalysisValidationIssue[],
  ) {
    super(message);
    this.name = 'AnalysisContractError';
  }
}
