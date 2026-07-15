import { z } from 'zod';
import {
  CandidateEvidenceContentSchema,
  CapabilityBaselineDraftSchema,
  createEmptyCapabilityBaselineDraft,
  createEmptyCandidateEvidenceContent,
  type CandidateEvidenceContent,
  type CapabilityBaselineDraft,
  type CapabilityBaselineInputSnapshot,
} from '../../src/domain/capability-baseline';
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../llm/provider';
import { CapabilityBaselineError, invalidCapabilityInput } from './errors';

export interface CapabilityBaselineAiProvider {
  isConfigured(): boolean;
  modelName(): string;
  generateEvidence(snapshot: CapabilityBaselineInputSnapshot, signal?: AbortSignal): Promise<{
    rawText: string;
    model: string;
  }>;
  generateBaseline(snapshot: CapabilityBaselineInputSnapshot, signal?: AbortSignal): Promise<{
    rawText: string;
    model: string;
  }>;
}

const GENERATION_MAX_TOKENS = 8192;

const CandidateEvidenceListSchema = z.array(CandidateEvidenceContentSchema);

function evidenceTemplateJson(): string {
  return JSON.stringify([createEmptyCandidateEvidenceContent()], null, 2);
}

function baselineTemplateJson(): string {
  return JSON.stringify(createEmptyCapabilityBaselineDraft(), null, 2);
}

const GUARDRAILS = `能力护栏（必须遵守）：
- 短期无回复、已读未回、招聘暂停或冻结、单一岗位无回复，均不能作为强反证降低长期能力；只能是 neutral 弱信号或不确定性。
- 学历、年龄、城市供给、薪资、招聘偏好属于外部门槛或市场可达性，不得写成能力反证（polarity=counter），能力事实与外部门槛必须分离。
- 不得为形成单一结论而隐藏反证；支持证据与反证可以并存。
- 不得编造公司、薪资、投递、面试、拒绝、学历或项目事实；证据只能引用输入快照中真实存在的来源。
- 证据不足时必须显式标记 insufficient / exploratory，并说明还需要补什么证据。`;

export const CAPABILITY_EVIDENCE_SYSTEM_PROMPT = `你是 OfferFlow 的长期能力候选证据助手。只输出一个合法 JSON 数组，不输出 Markdown、不输出代码块、不输出解释文字。
数组每个元素是一条候选证据，字段结构如下（仅表达结构，禁止原样返回占位内容）：
\`\`\`
${evidenceTemplateJson()}
\`\`\`
字段取值约束：
- polarity 只能是 support / counter / neutral。
- strength 只能是 strong / medium / weak。
- sourceType 只能是 profile / resume_version / job / application / feedback_event / user_input。
- timePrecision 只能是 exact / date / approximate / unknown。
- sourceConfidence 只能是 exact / approximate / recalled / inferred。
- city 只能是 suzhou / wuxi / shanghai / hangzhou 或 null。
- observedAt 是毫秒时间戳整数或 null。
- 所有展示性字符串使用非空中文；sourceId 只能引用输入中真实存在的 ID，或为 null。
${GUARDRAILS}
只输出 JSON 数组，样本不足时可返回空数组 []，但不得编造内容填充。`;

export const CAPABILITY_BASELINE_SYSTEM_PROMPT = `你是 OfferFlow 的长期能力基线助手。只输出一个合法 JSON 对象，不输出 Markdown、不输出代码块、不输出解释文字。
当前能力基线的严格 JSON 结构模板如下（仅表达字段结构，禁止原样返回占位内容）：
\`\`\`
${baselineTemplateJson()}
\`\`\`
字段取值约束：
- capabilities 是能力维度数组，可动态扩展，不要写死为固定条数。每个维度：{ key, label, conclusion, conclusionStatus, supportingEvidenceRefs[], counterEvidenceRefs[], unverified[], largestUncertainty }。
- conclusionStatus 与 overallConfidence 只能是 established / supported / exploratory / insufficient / contradicted。
- externalConstraints 每个元素：{ key, kind, label, summary, evidenceRefs[] }；kind 只能是 education / age / city_supply / salary / hiring_preference / other。
- supportingEvidenceRefs / counterEvidenceRefs / evidenceRefs 只能填写输入快照 acceptedEvidence[].id 中真实存在的 id 字符串；若 acceptedEvidence 为空，这些数组必须为空数组 []；禁止填写简历字段名、profile 字段名、来源标签或任何非 id 文本。
- 所有展示性字符串使用非空中文。
${GUARDRAILS}
只输出 JSON 对象。`;

const EVIDENCE_REPAIR_INSTRUCTION = `你上一次返回的 JSON 结构错误。
只修复字段结构并补齐严格 Schema 所需字段。
不得新增输入快照中不存在的事实。
不得改变已有事实含义。
无法从证据确认的内容必须标记为"证据不足，尚待验证"，并使用 insufficient 或 exploratory。
只返回修复后的 JSON 数组。`;

const BASELINE_REPAIR_INSTRUCTION = `你上一次返回的 JSON 结构错误。
只修复字段结构并补齐严格 Schema 所需字段。
不得新增输入快照中不存在的事实。
不得改变已有事实含义。
无法从证据确认的内容必须标记为"证据不足，尚待验证"，并使用 insufficient 或 exploratory。
只返回修复后的 JSON 对象。`;

function extractJson(rawText: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(rawText)?.[1]?.trim();
  const candidate = fenced ?? rawText.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const startObject = candidate.indexOf('{');
    const startArray = candidate.indexOf('[');
    const usesArray = startArray >= 0 && (startObject < 0 || startArray < startObject);
    const open = usesArray ? '[' : '{';
    const close = usesArray ? ']' : '}';
    const start = candidate.indexOf(open);
    const end = candidate.lastIndexOf(close);
    if (start < 0 || end <= start) throw new Error('未找到 JSON 结构');
    return JSON.parse(candidate.slice(start, end + 1));
  }
}

export function parseCapabilityEvidenceAiOutput(rawText: string): CandidateEvidenceContent[] {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    throw new CapabilityBaselineError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 输出不是合法 JSON', {
      reason: (error as Error).message,
    });
  }
  const result = CandidateEvidenceListSchema.safeParse(parsed);
  if (!result.success) {
    const validation = invalidCapabilityInput(result.error);
    throw new CapabilityBaselineError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 候选证据结构校验失败', {
      ...validation.details,
    });
  }
  return result.data;
}

export function parseCapabilityBaselineAiOutput(rawText: string): CapabilityBaselineDraft {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    throw new CapabilityBaselineError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 输出不是合法 JSON', {
      reason: (error as Error).message,
    });
  }
  const result = CapabilityBaselineDraftSchema.safeParse(parsed);
  if (!result.success) {
    const validation = invalidCapabilityInput(result.error);
    throw new CapabilityBaselineError(422, 'AI_STRUCTURED_OUTPUT_INVALID', 'AI 能力基线结构校验失败', {
      ...validation.details,
    });
  }
  return result.data;
}

function structuralError(check: () => void): CapabilityBaselineError | null {
  try {
    check();
    return null;
  } catch (error) {
    if (error instanceof CapabilityBaselineError && error.code === 'AI_STRUCTURED_OUTPUT_INVALID') {
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
      throw new CapabilityBaselineError(503, 'AI_PROVIDER_TIMEOUT', result.error);
    }
    throw new CapabilityBaselineError(503, 'AI_PROVIDER_UNAVAILABLE', result.error);
  }
  return { rawText: result.rawText, model: result.model };
}

function buildRepairMessage(
  template: string,
  instruction: string,
  snapshot: CapabilityBaselineInputSnapshot,
  previousRawText: string,
  details: Record<string, unknown>,
): string {
  const errorDescription = details.fieldErrors !== undefined
    ? JSON.stringify(details.fieldErrors, null, 2)
    : String(details.reason ?? '未知结构错误');
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

原始只读输入快照：
\`\`\`
${JSON.stringify(snapshot)}
\`\`\`

${instruction}`;
}

export const deepSeekCapabilityBaselineProvider: CapabilityBaselineAiProvider = {
  isConfigured: isLlmConfigured,
  modelName: () => getLlmConfig().model || 'unknown',

  async generateEvidence(snapshot, signal) {
    const first = await callModel(
      CAPABILITY_EVIDENCE_SYSTEM_PROMPT,
      `请基于以下只读输入快照生成候选能力证据数组：\n${JSON.stringify(snapshot)}`,
      signal,
    );
    const firstError = structuralError(() => parseCapabilityEvidenceAiOutput(first.rawText));
    if (firstError === null) return first;
    const second = await callModel(
      CAPABILITY_EVIDENCE_SYSTEM_PROMPT,
      buildRepairMessage(evidenceTemplateJson(), EVIDENCE_REPAIR_INSTRUCTION, snapshot, first.rawText, firstError.details),
      signal,
    );
    const secondError = structuralError(() => parseCapabilityEvidenceAiOutput(second.rawText));
    if (secondError === null) return second;
    throw new CapabilityBaselineError(
      422, 'AI_STRUCTURED_OUTPUT_INVALID',
      'AI 连续两次未能生成符合能力证据协议的内容，请重新生成或使用手工录入',
      { ...secondError.details, attempts: 2 },
    );
  },

  async generateBaseline(snapshot, signal) {
    const first = await callModel(
      CAPABILITY_BASELINE_SYSTEM_PROMPT,
      `请基于以下只读输入快照生成长期能力基线提案：\n${JSON.stringify(snapshot)}`,
      signal,
    );
    const firstError = structuralError(() => parseCapabilityBaselineAiOutput(first.rawText));
    if (firstError === null) return first;
    const second = await callModel(
      CAPABILITY_BASELINE_SYSTEM_PROMPT,
      buildRepairMessage(baselineTemplateJson(), BASELINE_REPAIR_INSTRUCTION, snapshot, first.rawText, firstError.details),
      signal,
    );
    const secondError = structuralError(() => parseCapabilityBaselineAiOutput(second.rawText));
    if (secondError === null) return second;
    throw new CapabilityBaselineError(
      422, 'AI_STRUCTURED_OUTPUT_INVALID',
      'AI 连续两次未能生成符合能力基线协议的内容，请重新生成或使用手工提案',
      { ...secondError.details, attempts: 2 },
    );
  },
};
