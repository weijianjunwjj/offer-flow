/**
 * V8-4 单岗位分析 Prompt 与语义版本常量。
 *
 * Prompt 只承载紧凑字段契约与 JSON 模板（不塞入 Zod 源码），要求模型只输出单个合法 JSON，
 * 严格符合 JobMatchAnalysisPayloadV1，且只引用输入 Evidence Catalog 的 evidenceKey。
 * 这些版本常量参与 inputHash：语义变化即产出不同 hash。
 */
import type { JobMatchAnalysisLlmInputV1 } from './llmContracts';

export const JOB_MATCH_ANALYSIS_PROMPT_VERSION = 'job-match-analysis:v1';
export const JOB_MATCH_ANALYSIS_POLICY_VERSION = 'job-match-analysis-policy:v1';
export const JOB_MATCH_ANALYSIS_PROVIDER_POLICY_VERSION = 'provider-policy:v1';

/** 结论点紧凑契约（对齐 AnalysisPointSchema，不含 Zod 源码）。 */
const POINT_CONTRACT = `point 对象字段（全部必填）：
{ "statement": string, "kind": "fact"|"inference"|"user_preference"|"rule_result"|"unknown",
  "evidenceKeys": string[], "explanation": string,
  "impact": "positive"|"negative"|"mixed"|"unknown",
  "severity": "critical"|"high"|"medium"|"low"|"none",
  "confidence": "low"|"medium"|"high" }
- kind 非 unknown 的 point 必须至少引用一个 evidenceKeys；
- kind=unknown 的 point 不得 impact=negative（缺失≠负面事实）；
- evidenceKeys 只能来自输入 evidenceCatalog 的 evidenceKey，禁止编造。`;

/** 顶层 JSON 模板（仅表达字段结构，禁止原样返回占位内容）。 */
const OUTPUT_TEMPLATE = `{
  "contractVersion": 1,
  "jobFacts": [{ "statement": string, "kind": <point.kind>, "evidenceKeys": string[] }],
  "dimensions": {
    "roleFit": { "summary": string, "assessment": "strong"|"moderate"|"weak"|"unknown", "points": point[] },
    "capabilityFit": { ... 同 roleFit ... },
    "businessAndCompanyFit": { ... 同 roleFit ... },
    "cityAndSalaryFit": { ... 同 roleFit ... }
  },
  "transferableEvidence": point[], "gaps": point[], "risks": point[],
  "counterEvidence": point[], "uncertainties": point[],
  "missingEvidence": string[],
  "hardConstraints": point[],
  "recommendation": "apply_now"|"stretch"|"verify"|"skip",
  "confidence": "low"|"medium"|"high",
  "summary": string,
  "recruiterQuestions": string[], "communicationAngles": string[]
}`;

function buildSystemPrompt(): string {
  return `你是 OfferFlow 的单岗位匹配分析助手。只输出一个合法 JSON 对象，不输出 Markdown、代码块或任何解释文字。

严格输出契约（必须全部遵守）：
1. 只输出单个 JSON 对象，严格符合下方结构，禁止多余字段、禁止省略必填字段。
2. 结论只能引用输入 evidenceCatalog 中真实存在的 evidenceKey；禁止编造 evidenceKey。
3. 区分 fact / inference / user_preference / rule_result / unknown；不得把推断当作事实。
4. 缺失信息用 uncertainties / missingEvidence 表达，不得当作负面事实（缺失≠negative）。
5. 不得编造经历、薪资、公司、市场或反馈事实；只基于输入。
6. 不得输出任何数据库 ID；不得输出 HTML 或 Markdown；不得输出 0～100 的匹配分。
7. recommendation 只能是 apply_now / stretch / verify / skip。

${POINT_CONTRACT}

输出结构模板（仅表达字段，禁止原样返回占位符）：
${OUTPUT_TEMPLATE}`;
}

export const JOB_MATCH_ANALYSIS_SYSTEM_PROMPT = buildSystemPrompt();

/** 首次生成的 user 消息：只承载脱敏 LLM 输入。 */
export function buildAnalysisUserMessage(input: JobMatchAnalysisLlmInputV1): string {
  return `请基于以下只读脱敏输入生成单岗位匹配分析：\n${JSON.stringify(input)}`;
}

/**
 * 一次结构修复的 user 消息：附上一轮原始输出与**安全截断**的校验摘要（不含 rawText 全文之外的敏感值），
 * 要求模型仅修结构、不引入新事实、只重复引用目录内 evidenceKey。
 */
export function buildAnalysisRepairMessage(
  input: JobMatchAnalysisLlmInputV1,
  previousRawText: string,
  validationSummary: string,
): string {
  return `你上一次的输出未通过结构校验。请只修复结构问题并重新输出单个合法 JSON。

上一次原始输出（仅供你定位问题，不要照抄错误结构）：
${previousRawText}

结构校验摘要（稳定语义，不含完整错误上下文）：
${validationSummary}

要求：不得新增输入中不存在的事实；不得改变已有事实含义；evidenceKeys 只能引用输入 evidenceCatalog 中真实存在的键；只返回修复后的 JSON。

原始只读脱敏输入：
${JSON.stringify(input)}`;
}
