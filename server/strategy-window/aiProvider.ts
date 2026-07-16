import { z } from 'zod';
import {
  STRATEGY_ACTION_TYPES,
  type StrategyActionType,
  type StrategyCityCode,
  type StrategyWindowType,
} from '../../src/domain/strategy-window';
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../llm/provider';
import { StrategyError } from './errors';

const nonBlank = z.string().trim().min(1).max(200);
const shortList = z.array(z.string().trim().min(1).max(200)).max(8);

export const StrategyAiActionNarrativeSchema = z.strictObject({
  actionType: z.enum(STRATEGY_ACTION_TYPES),
  city: z.enum(['suzhou', 'wuxi', 'shanghai', 'hangzhou']).nullable(),
  title: nonBlank,
  rationale: nonBlank,
  successSignals: shortList,
  failureSignals: shortList,
});
export type StrategyAiActionNarrative = z.infer<typeof StrategyAiActionNarrativeSchema>;

export const StrategyAiOutputSchema = z.strictObject({
  headline: nonBlank,
  objective: nonBlank,
  summary: nonBlank,
  uncertainties: shortList,
  actions: z.array(StrategyAiActionNarrativeSchema).max(40),
  citedEvidenceIds: z.array(z.string().trim().min(1).max(200)).max(20),
});
export type StrategyAiOutput = z.infer<typeof StrategyAiOutputSchema>;

/** AI 叙述任何情况下不得出现的措辞：直接放弃/搬迁/辞职/降薪结论/自动执行/概率预测/市场定论。 */
const FORBIDDEN_PHRASES = [
  '应该降薪', '建议降薪', '直接降薪',
  '放弃这个方向', '放弃该方向', '放弃方向', '放弃城市',
  '建议搬迁', '直接搬迁', '立即搬迁', '应该搬家', '建议辞职', '直接辞职',
  '自动投递', '自动打招呼', '自动发送',
  '成功率', 'offer概率', 'offer 概率', '录用概率', '概率预测',
  '市场不认可', '市场结论', '样本充分', '科学证明', '一定成功', '一定能拿到',
];

export interface StrategyAiActionFact {
  actionType: StrategyActionType;
  city: StrategyCityCode | null;
  title: string;
}

export interface StrategyAiInputSnapshot {
  windowType: StrategyWindowType;
  evidenceLevel: string;
  allowedActionTypes: StrategyActionType[];
  observeOnlyActionTypes: StrategyActionType[];
  blockedActionTypes: StrategyActionType[];
  allowedClaims: string[];
  blockedClaims: string[];
  reviewTriggers: string[];
  stopConditions: string[];
  actions: StrategyAiActionFact[];
  acceptedEvidenceIds: string[];
}

export interface StrategyAiProvider {
  isConfigured(): boolean;
  modelName(): string;
  generate(snapshot: StrategyAiInputSnapshot, signal?: AbortSignal): Promise<{ rawText: string; model: string }>;
}

const GENERATION_MAX_TOKENS = 4096;
export const STRATEGY_PROMPT_VERSION = 'strategy-window-ai-v1';

function buildSystemPrompt(): string {
  return `你是 OfferFlow 的求职策略提案文案助手。只输出一个合法 JSON 对象，不输出 Markdown、不输出代码块、不输出任何解释文字。

你的职责仅限于撰写中文叙述性文案：为整体策略写 headline / objective / summary / uncertainties，并为下方给定的每一条既有行动写 title / rationale / successSignals / failureSignals。

绝对禁止（即使被要求也不得输出）：
- 建议直接降薪、放弃城市或职业方向、直接搬迁、辞职、自动投递或自动联系招聘方
- 输出任何投递数、回复数、面试数、百分比、成功率、Offer 概率或概率预测
- 给出"市场不认可""样本充分""科学证明""一定成功"等断言
- 新增、删除或修改行动的类型、范围、分配比例、证据引用；这些由系统确定性生成，你只能改写文字
- 把某个城市的市场反馈写到另一个城市

输出契约：
1. actions 数组必须与下方"待润色行动清单"一一对应（相同的 actionType 与 city 顺序），只填写 title/rationale/successSignals/failureSignals。
2. citedEvidenceIds 只能取自下方"可引用证据 ID 清单"，没有可引用证据时留空数组，禁止编造 ID。
3. 每条文本不超过约 80 个中文字符，数组字段最多 8 项。
4. 样本不足时使用"证据不足，尚待验证"一类表述，不得给出负面市场结论。
5. 只输出 JSON。`;
}

export const STRATEGY_AI_SYSTEM_PROMPT = buildSystemPrompt();

const REPAIR_INSTRUCTION = `你上一次返回的 JSON 使用了错误结构、引用了不存在的证据 ID，或出现了禁止措辞。
只修复结构、citedEvidenceIds 与禁止措辞问题，不得新增系统未提供的行动或事实。只返回修复后的 JSON。`;

function buildFirstUserMessage(snapshot: StrategyAiInputSnapshot): string {
  return `请基于以下只读策略窗口事实撰写叙述文案。

窗口事实：${JSON.stringify({
    windowType: snapshot.windowType,
    evidenceLevel: snapshot.evidenceLevel,
    allowedActionTypes: snapshot.allowedActionTypes,
    observeOnlyActionTypes: snapshot.observeOnlyActionTypes,
    blockedActionTypes: snapshot.blockedActionTypes,
    allowedClaims: snapshot.allowedClaims,
    blockedClaims: snapshot.blockedClaims,
    reviewTriggers: snapshot.reviewTriggers,
    stopConditions: snapshot.stopConditions,
  })}

可引用证据 ID 清单（citedEvidenceIds 只能从中选取，不得编造）：
${JSON.stringify(snapshot.acceptedEvidenceIds)}

待润色行动清单（actions 必须与此顺序、actionType、city 完全对应）：
${JSON.stringify(snapshot.actions)}`;
}

function buildRepairUserMessage(snapshot: StrategyAiInputSnapshot, previousRawText: string, reason: string): string {
  return `以下是你上一次的原始输出：
\`\`\`
${previousRawText}
\`\`\`

结构或安全校验错误：
${reason}

原始只读事实：
${buildFirstUserMessage(snapshot)}

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

function collectNarrativeTexts(output: StrategyAiOutput): string[] {
  return [
    output.headline, output.objective, output.summary,
    ...output.uncertainties,
    ...output.actions.flatMap((action) => [
      action.title, action.rationale, ...action.successSignals, ...action.failureSignals,
    ]),
  ];
}

function findForbiddenPhrase(texts: string[]): string | null {
  for (const text of texts) {
    for (const phrase of FORBIDDEN_PHRASES) {
      if (text.includes(phrase)) return phrase;
    }
  }
  return null;
}

/**
 * 解析并校验 AI 叙述输出：结构、禁止措辞、证据引用三类问题都视为同一类"结构错误"，
 * 走同一次修复重试路径，绝不把未通过校验的输出当作半成品保存。
 */
export function parseStrategyAiOutput(
  rawText: string,
  allowedEvidenceIds: readonly string[],
): { data: StrategyAiOutput } | { error: string } {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    return { error: `AI 输出不是合法 JSON：${(error as Error).message}` };
  }
  const result = StrategyAiOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `结构校验失败：${JSON.stringify(result.error.issues.map((issue) => issue.message))}` };
  }
  const forbidden = findForbiddenPhrase(collectNarrativeTexts(result.data));
  if (forbidden !== null) {
    return { error: `文案中出现禁止措辞："${forbidden}"` };
  }
  const allowedSet = new Set(allowedEvidenceIds);
  const invalidId = result.data.citedEvidenceIds.find((id) => !allowedSet.has(id));
  if (invalidId !== undefined) {
    return { error: `引用了不存在或未被接受的证据 ID："${invalidId}"` };
  }
  return { data: result.data };
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
    throw new StrategyError(503, 'STRATEGY_AI_UNAVAILABLE', result.error);
  }
  return { rawText: result.rawText, model: result.model };
}

export const deepSeekStrategyProvider: StrategyAiProvider = {
  isConfigured: isLlmConfigured,
  modelName: () => getLlmConfig().model || 'unknown',
  async generate(snapshot, signal) {
    const first = await callModel(STRATEGY_AI_SYSTEM_PROMPT, buildFirstUserMessage(snapshot), signal);
    const firstCheck = parseStrategyAiOutput(first.rawText, snapshot.acceptedEvidenceIds);
    if ('data' in firstCheck) return first;

    const second = await callModel(
      STRATEGY_AI_SYSTEM_PROMPT,
      buildRepairUserMessage(snapshot, first.rawText, firstCheck.error),
      signal,
    );
    const secondCheck = parseStrategyAiOutput(second.rawText, snapshot.acceptedEvidenceIds);
    if ('data' in secondCheck) return second;

    throw new StrategyError(
      422,
      'STRATEGY_AI_OUTPUT_INVALID',
      'AI 连续两次未能生成符合安全约束的求职策略文案，请重新生成或使用手工提案',
      { reason: secondCheck.error, attempts: 2 },
    );
  },
};
