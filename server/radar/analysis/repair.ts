/**
 * V8-4 单岗位分析"生成 + 一次结构修复"纯编排（不建任务、不写数据库、不注册路由）。
 *
 * 固定流程：generate → parse → 成功即返回；仅结构问题（JSON/Schema/unknown evidenceKey/
 * HTML/超大）允许一次 repair → 再 parse；第二次仍失败抛 STRUCTURE_REPAIR_FAILED。
 * 绝不第三次调用模型。
 *
 * 不进入 repair 的错误：Provider 超时/网络/限流/取消/配置错误（Provider 直接抛出），
 * 以及敏感内容泄漏 / 内部 ID 泄漏（映射为对应终态，绝不把泄漏内容送回模型）。
 */
import { AnalysisContractError, type AnalysisContractErrorCode, type AnalysisValidationIssue } from './contractErrors';
import {
  parseJobMatchAnalysisPayload,
  ANALYSIS_PAYLOAD_CONTRACT_VERSION,
  type JobMatchAnalysisPayloadV1,
} from './analysisPayload';
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from './provider';
import type { JobMatchAnalysisLlmInputV1 } from './llmContracts';

/** 仅这些结构问题允许一次 repair（缺失字段/非法 JSON/目录外引用/HTML/超大）。 */
const REPAIRABLE_CODES: ReadonlySet<AnalysisContractErrorCode> = new Set([
  'ANALYSIS_JSON_INVALID',
  'ANALYSIS_SCHEMA_INVALID',
  'ANALYSIS_UNKNOWN_EVIDENCE_KEY',
  'ANALYSIS_HTML_NOT_ALLOWED',
  'ANALYSIS_PAYLOAD_TOO_LARGE',
]);

/** 泄漏类契约错误绝不进入 repair：映射为对应安全终态码。 */
const LEAK_CODE_MAP: Partial<Record<AnalysisContractErrorCode, 'SENSITIVE_CONTENT_LEAK' | 'INTERNAL_ID_LEAK'>> = {
  ANALYSIS_SENSITIVE_CONTENT: 'SENSITIVE_CONTENT_LEAK',
  ANALYSIS_INTERNAL_ID_LEAK: 'INTERNAL_ID_LEAK',
};

/** 某契约错误是否属于"可一次修复的结构问题"。 */
export function isRepairableContractError(code: AnalysisContractErrorCode): boolean {
  return REPAIRABLE_CODES.has(code);
}

/** 校验摘要总长上限：足够精确指导修复，又不至于把整份 issues 铺开。 */
const VALIDATION_SUMMARY_MAX = 800;

/**
 * 安全校验摘要：承载稳定错误码、目标契约版本与**逐条**脱敏问题（path + code + 稳定 message），
 * 绝不回显 rawText 全文、JSON.parse 明文片段或敏感值。用于修复 prompt 与失败终态持久化。
 */
export function buildValidationSummary(
  code: AnalysisContractErrorCode,
  detail: string | undefined,
  issues: readonly AnalysisValidationIssue[] | undefined,
): string {
  const header = `结构错误码=${code}；目标契约版本=JobMatchAnalysisPayloadV1(contractVersion=${ANALYSIS_PAYLOAD_CONTRACT_VERSION})`;
  const lines: string[] = [];
  if (issues !== undefined && issues.length > 0) {
    for (const issue of issues) {
      const where = issue.path !== '' ? issue.path : '(根对象)';
      lines.push(`- 字段 ${where}：${issue.code} — ${issue.message}`);
    }
  } else if (detail !== undefined && detail !== '') {
    lines.push(`- 位置：${detail}`);
  }
  const body = lines.length > 0 ? `\n具体问题：\n${lines.join('\n')}` : '';
  return `${header}。${body}\n请仅修复上述结构问题后重新输出单个合法 JSON，勿新增事实、勿引入目录外 evidenceKey。`.slice(
    0,
    VALIDATION_SUMMARY_MAX,
  );
}

/** 把泄漏类契约错误映射为安全终态（不含泄漏内容）。 */
function leakError(error: AnalysisContractError): AnalysisProviderError | null {
  const mapped = LEAK_CODE_MAP[error.code];
  if (mapped === undefined) return null;
  const label = mapped === 'SENSITIVE_CONTENT_LEAK' ? '模型输出包含敏感内容' : '模型输出包含内部数据库 ID';
  return new AnalysisProviderError(mapped, label, error.detail);
}

export interface GenerateAndParseArgs {
  provider: JobMatchAnalysisProvider;
  llmInput: JobMatchAnalysisLlmInputV1;
  allowedEvidenceKeys: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface GenerateAndParseResult {
  payload: JobMatchAnalysisPayloadV1;
  rawText: string;
  provider: string;
  model: string;
  /** 是否经过一次结构修复才成功。 */
  repaired: boolean;
}

/** 解析一次 Provider 产物；仅抛 AnalysisContractError（其余错误上抛调用方）。 */
function parseCall(call: AnalysisProviderCallResult, allowed: ReadonlySet<string>): JobMatchAnalysisPayloadV1 {
  return parseJobMatchAnalysisPayload(call.rawText, allowed);
}

/**
 * 生成并解析单岗位分析结果，最多一次结构修复。
 * 关键不变量：最多两次模型调用；泄漏 / Provider 传输错误不进入 repair。
 */
export async function generateAndParseJobMatchAnalysis(
  args: GenerateAndParseArgs,
): Promise<GenerateAndParseResult> {
  const { provider, llmInput, allowedEvidenceKeys, signal } = args;

  // 第一次：generate（Provider 传输错误直接上抛，不 repair）。
  const first = await provider.generate(llmInput, signal);
  let firstError: AnalysisContractError;
  try {
    const payload = parseCall(first, allowedEvidenceKeys);
    return { payload, rawText: first.rawText, provider: first.provider, model: first.model, repaired: false };
  } catch (error) {
    if (!(error instanceof AnalysisContractError)) throw error;
    firstError = error;
  }

  // 泄漏类：绝不送回模型，映射为安全终态。
  const leak = leakError(firstError);
  if (leak !== null) throw leak;

  // 非结构问题（不可修复）：直接以 SCHEMA_INVALID 终止，不 repair，携带具体问题清单。
  if (!isRepairableContractError(firstError.code)) {
    throw new AnalysisProviderError(
      'SCHEMA_INVALID',
      '模型输出未通过结构校验',
      firstError.code,
      firstError.issues,
    );
  }

  // 第二次：一次结构修复（同一 LLM 输入 + 精确校验摘要）。任何再次失败 → STRUCTURE_REPAIR_FAILED。
  const repairCall = await provider.repair(
    llmInput,
    first.rawText,
    buildValidationSummary(firstError.code, firstError.detail, firstError.issues),
    signal,
  );
  try {
    const payload = parseCall(repairCall, allowedEvidenceKeys);
    return { payload, rawText: repairCall.rawText, provider: repairCall.provider, model: repairCall.model, repaired: true };
  } catch (error) {
    if (!(error instanceof AnalysisContractError)) throw error;
    // 修复后仍失败：携带**第二次**的具体问题清单，供任务失败摘要精确落库。
    throw new AnalysisProviderError(
      'STRUCTURE_REPAIR_FAILED',
      '结构修复后仍未通过校验',
      error.code,
      error.issues,
    );
  }
}
