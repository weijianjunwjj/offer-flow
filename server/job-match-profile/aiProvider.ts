import {
  JobMatchProfileDraftSchema,
  createEmptyJobMatchProfileDraft,
  type JobMatchProfileDraft,
  type JobMatchProfileInputSnapshot,
} from '../../src/domain/job-match-profile';
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../llm/provider';
import { JobMatchProfileError, invalidProposal } from './errors';

export interface JobMatchProfileAiProvider {
  isConfigured(): boolean;
  modelName(): string;
  generate(snapshot: JobMatchProfileInputSnapshot, signal?: AbortSignal): Promise<{
    rawText: string;
    model: string;
  }>;
}

const GENERATION_MAX_TOKENS = 8192;

const FORBIDDEN_LEGACY_FIELDS = [
  'profileSummary',
  'overallAssessment',
  'careerStrategy',
  'evidenceSummary',
  'recommendation',
  'marketPosition',
  'riskLevel',
];

const FIELD_CONTRACT = `数组与嵌套对象的元素字段规格（必须严格遵守字段名，禁止改名、禁止新增字段、禁止省略字段）：

- coreCapabilities[] 每个元素：
  { "key": string, "label": string, "level": "core" | "supporting" | "to_validate", "summary": string, "evidenceRefs": string[] }

- constraints[] 每个元素：
  { "key": string, "label": string, "summary": string, "evidenceRefs": string[] }
  注意：constraints 元素禁止使用 description / category / impact 等字段名，只能使用 key、label、summary、evidenceRefs。

- supportingEvidence[] 与 counterEvidence[]（顶层以及每个城市内）每个元素：
  { "sourceType": "profile" | "resume_version" | "job" | "application" | "feedback_event" | "user_input",
    "sourceId": string | null,
    "label": string,
    "polarity": "support" | "counter" | "neutral",
    "strength": "strong" | "medium" | "weak",
    "city": "suzhou" | "wuxi" | "shanghai" | "hangzhou" | null,
    "summary": string }

- stretchRoles / primaryRoles / safeRoles（顶层以及每个城市内）都是同一种 roleBand 对象：
  { "roleTitles": string[], "roleFamilies": string[],
    "salaryRange": { "minK": number | null, "maxK": number | null, "note": string },
    "companySizes": string[], "companyTypes": string[], "industries": string[],
    "technicalFocus": string[], "suitableReasons": string[], "risks": string[] }

- cityProfiles[] 每个元素：
  { "city": "suzhou" | "wuxi" | "shanghai" | "hangzhou",
    "confidence": "insufficient" | "exploratory" | "actionable",
    "summary": string, "highestReachableRole": string,
    "stretchRoles": roleBand, "primaryRoles": roleBand, "safeRoles": roleBand,
    "educationBarrier": string, "salaryNote": string, "preferredCompanyProfile": string[],
    "supportingEvidence": evidence[], "counterEvidence": evidence[],
    "missingEvidence": string[], "borrowedEvidence": borrowedEvidence[] }

- borrowedEvidence[] 每个元素：
  { "sourceCity": "suzhou" | "wuxi" | "shanghai" | "hangzhou",
    "reason": string, "discountNote": string, "notApplicableTo": string[] }

- idealEnvironment 对象：
  { "companySizes": string[], "companyTypes": string[], "industries": string[], "teamTraits": string[], "description": string }

- acceptableRange 对象：
  { "roleTitles": string[], "cities": ("suzhou" | "wuxi" | "shanghai" | "hangzhou")[],
    "salaryNote": string, "companyTypes": string[], "workModes": string[], "notes": string[] }

上面模板中出现的空数组仅表示"允许为空"，一旦填充元素，元素必须严格符合以上字段规格。`;

function buildOutputTemplateJson(): string {
  return JSON.stringify(createEmptyJobMatchProfileDraft(), null, 2);
}

function buildSystemPrompt(): string {
  const template = buildOutputTemplateJson();
  return `你是 OfferFlow 的岗位匹配画像提案助手。只输出一个合法 JSON 对象，不输出 Markdown、不输出代码块、不输出任何解释文字。

当前岗位匹配画像的严格 JSON 结构模板如下（仅表达字段结构，禁止原样返回，禁止保留空字符串或占位内容）：
\`\`\`
${template}
\`\`\`

${FIELD_CONTRACT}

输出契约（必须全部遵守）：
1. 模板只表达字段结构，不能原样返回空字符串或占位内容。
2. 所有必填字符串字段必须是非空中文。
3. 有证据支撑时填写基于证据的事实判断。
4. 没有证据时使用"证据不足，尚待验证"、"当前样本不足，暂不形成正式结论"等表述，并将 confidence 标记为 insufficient 或 exploratory。
5. 不得编造公司、薪资、投递、面试、拒绝、学历或项目事实。
6. cityProfiles 必须且只能包含 suzhou、wuxi、shanghai、hangzhou 四个城市，且各恰好一次。
7. 每个城市必须使用当前 Schema 的完整字段集合（不能省略字段，也不能新增字段）。
8. confidence 只能是：insufficient、exploratory、actionable。
9. 能力（coreCapabilities）的 level 只能是：core、supporting、to_validate。
10. 证据（evidence）的 polarity 只能是：support、counter、neutral。
11. 证据（evidence）的 strength 只能是：strong、medium、weak。
12. 只输出 JSON，不输出 Markdown、不输出代码块、不输出解释性文字。

严禁在输出中使用以下旧版字段（这些字段已废弃，任何层级出现都视为结构错误）：
${FORBIDDEN_LEGACY_FIELDS.join('、')}

篇幅限制：
- 岗位名称类数组（roleTitles 等）最多 4 项。
- 公司类型 / 行业 / 技术方向类数组最多 4 项。
- 证据类数组（supportingEvidence / counterEvidence 等）最多 5 项。
- 每条 summary 类文本控制在约 120 个中文字符以内。
- 不得在 4 个城市中重复粘贴完全相同的全局描述。
- 样本不足时数组可以留空，但不得编造内容填充。

其余规则：
- 不要因为短期无回复下调岗位定位、薪资或能力评价。
- 不要跨城市混合薪资、回复率、岗位供给、学历门槛或公司规模结论。
- 必须区分冲刺岗位、主攻岗位和稳妥岗位。
- 必须列出支持证据、相反证据和缺失证据。
- 证据引用只能使用输入中真实存在的来源 ID，或使用 sourceType=user_input/sourceId=null。`;
}

export const JOB_MATCH_PROFILE_SYSTEM_PROMPT = buildSystemPrompt();

const REPAIR_INSTRUCTION = `你上一次返回的 JSON 使用了错误结构。
只修复字段结构并补齐严格 Schema 所需字段。
不得新增输入快照中不存在的事实。
不得改变已有事实含义。
无法从证据确认的内容必须标记为"证据不足，尚待验证"，
并使用 insufficient 或 exploratory。
只返回修复后的 JSON。`;

function buildFirstUserMessage(snapshot: JobMatchProfileInputSnapshot): string {
  return `请基于以下只读输入快照生成岗位匹配画像提案：\n${JSON.stringify(snapshot)}`;
}

function buildRepairUserMessage(
  snapshot: JobMatchProfileInputSnapshot,
  previousRawText: string,
  fieldErrors: Record<string, string[]> | undefined,
  reason: string | undefined,
): string {
  const template = buildOutputTemplateJson();
  const errorDescription = fieldErrors !== undefined
    ? JSON.stringify(fieldErrors, null, 2)
    : (reason ?? '未知结构错误');
  return `以下是你上一次的原始输出：
\`\`\`
${previousRawText}
\`\`\`

结构校验错误（Zod fieldErrors 或原因）：
\`\`\`
${errorDescription}
\`\`\`

当前完整输出模板（仅表达字段结构）：
\`\`\`
${template}
\`\`\`

${FIELD_CONTRACT}

原始只读输入快照：
\`\`\`
${JSON.stringify(snapshot)}
\`\`\`

${REPAIR_INSTRUCTION}`;
}

function extractJson(rawText: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText)?.[1]?.trim();
  const candidate = fenced ?? rawText.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('未找到 JSON 对象');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export function parseJobMatchProfileAiOutput(rawText: string): JobMatchProfileDraft {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    throw new JobMatchProfileError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 输出不是合法 JSON', {
      reason: (error as Error).message,
    });
  }
  const result = JobMatchProfileDraftSchema.safeParse(parsed);
  if (!result.success) {
    const validation = invalidProposal(result.error);
    throw new JobMatchProfileError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 画像提案结构校验失败', {
      ...validation.details,
    });
  }
  return result.data;
}

function tryParseJobMatchProfileAiOutput(rawText: string): JobMatchProfileError | null {
  try {
    parseJobMatchProfileAiOutput(rawText);
    return null;
  } catch (error) {
    if (error instanceof JobMatchProfileError && error.code === 'AI_STRUCTURED_OUTPUT_INVALID') {
      return error;
    }
    throw error;
  }
}

async function callModel(
  systemPrompt: string,
  userMessage: string,
  signal: AbortSignal | undefined,
): Promise<{ rawText: string; model: string }> {
  const result = await chatCompletion(systemPrompt, userMessage, {
    maxTokens: GENERATION_MAX_TOKENS,
    temperature: 0.1,
    signal,
  });
  if (result.error) {
    if (result.error.includes('超时')) {
      throw new JobMatchProfileError(503, 'AI_PROVIDER_TIMEOUT', result.error);
    }
    throw new JobMatchProfileError(503, 'AI_PROVIDER_UNAVAILABLE', result.error);
  }
  return { rawText: result.rawText, model: result.model };
}

export const deepSeekJobMatchProfileProvider: JobMatchProfileAiProvider = {
  isConfigured: isLlmConfigured,
  modelName: () => getLlmConfig().model || 'unknown',
  async generate(snapshot, signal) {
    const first = await callModel(JOB_MATCH_PROFILE_SYSTEM_PROMPT, buildFirstUserMessage(snapshot), signal);
    const firstError = tryParseJobMatchProfileAiOutput(first.rawText);
    if (firstError === null) return first;

    const second = await callModel(
      JOB_MATCH_PROFILE_SYSTEM_PROMPT,
      buildRepairUserMessage(
        snapshot,
        first.rawText,
        firstError.details.fieldErrors as Record<string, string[]> | undefined,
        firstError.details.reason as string | undefined,
      ),
      signal,
    );
    const secondError = tryParseJobMatchProfileAiOutput(second.rawText);
    if (secondError === null) return second;

    throw new JobMatchProfileError(
      422,
      'AI_STRUCTURED_OUTPUT_INVALID',
      'AI 连续两次未能生成符合岗位画像协议的内容，请重新生成或使用手工提案',
      { ...secondError.details, attempts: 2 },
    );
  },
};
