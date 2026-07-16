import { z } from 'zod';
import type { StrategyActionType, StrategyWindowType } from '../../src/domain/strategy-window';
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../llm/provider';
import { StrategyError } from './errors';

// 叙述字段长度上限（按产品可读长度设定，不为通过校验盲目放宽）。
const HEADLINE_MAX = 60;
const TITLE_MAX = 60;
const OBJECTIVE_MAX = 160;
const SUMMARY_MAX = 300;
const RATIONALE_MAX = 200;
const SIGNAL_MAX = 120;
const LIST_MAX = 8;

const headline = z.string().trim().min(1).max(HEADLINE_MAX);
const signalList = z.array(z.string().trim().min(1).max(SIGNAL_MAX)).max(LIST_MAX);

/**
 * AI 叙述 overlay：只允许补充叙事，按 actionId 引用确定性草稿中既有的行动。
 * 严格对象——不接受任何未知字段（如 citedEvidenceIds / actionType / city / priority /
 * allocationShare / targetCount / sourceEvidenceIds 等确定性字段），出现即结构错误。
 */
export const StrategyAiActionNarrativeSchema = z.strictObject({
  actionId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(TITLE_MAX),
  rationale: z.string().trim().min(1).max(RATIONALE_MAX),
  successSignals: signalList,
  failureSignals: signalList,
});
export type StrategyAiActionNarrative = z.infer<typeof StrategyAiActionNarrativeSchema>;

export const StrategyAiOutputSchema = z.strictObject({
  headline,
  objective: z.string().trim().min(1).max(OBJECTIVE_MAX),
  summary: z.string().trim().min(1).max(SUMMARY_MAX),
  uncertainties: z.array(z.string().trim().min(1).max(SIGNAL_MAX)).max(LIST_MAX),
  actionNarratives: z.array(StrategyAiActionNarrativeSchema).max(40),
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

/** 提供给 AI 的只读行动目标：AI 只能按 actionId 为这些既有行动补充叙事。 */
export interface StrategyAiActionTarget {
  actionId: string;
  actionType: StrategyActionType;
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
  actionTargets: StrategyAiActionTarget[];
}

export interface StrategyAiProvider {
  isConfigured(): boolean;
  modelName(): string;
  generate(snapshot: StrategyAiInputSnapshot, signal?: AbortSignal): Promise<{ rawText: string; model: string }>;
}

const GENERATION_MAX_TOKENS = 4096;
export const STRATEGY_PROMPT_VERSION = 'strategy-window-ai-v2';

function buildOverlayExampleJson(snapshot: StrategyAiInputSnapshot): string {
  return JSON.stringify({
    headline: '一句话策略标题',
    objective: '本阶段目标（一句话）',
    summary: '策略概述，两三句话说明当前只做可逆的证据收集与探索',
    uncertainties: ['当前样本有限，以下判断均为阶段性'],
    actionNarratives: snapshot.actionTargets.map((target) => ({
      actionId: target.actionId,
      title: target.title,
      rationale: '为什么在当前窗口内做这条行动',
      successSignals: ['出现的可复核正向信号'],
      failureSignals: ['需要停止或复盘的信号'],
    })),
  }, null, 2);
}

function buildSystemPrompt(): string {
  return `你是 OfferFlow 的求职策略提案文案助手。只输出一个合法 JSON 对象，不输出 Markdown、不输出代码块、不输出任何解释文字。

你的职责仅限于撰写中文叙述性文案：为整体策略写 headline / objective / summary / uncertainties，并按 actionId 为下方"待润色行动清单"中每一条既有行动写 title / rationale / successSignals / failureSignals。

输出对象只能且必须包含这些字段：
{
  "headline": string,
  "objective": string,
  "summary": string,
  "uncertainties": string[],
  "actionNarratives": [
    { "actionId": string, "title": string, "rationale": string, "successSignals": string[], "failureSignals": string[] }
  ]
}

硬性要求：
1. uncertainties / successSignals / failureSignals 必须是 JSON 数组（如 ["a","b"]），绝不能是字符串化数组（如 "[\\"a\\"]" 或 "a、b"）。
2. actionNarratives 里的 actionId 只能取自下方"待润色行动清单"中给出的 actionId，不得新增、删除或改写；不认识的 actionId 一律不要出现。
3. 禁止输出任何未列出的字段，尤其不得输出 citedEvidenceIds / sourceEvidenceIds / actionType / city / jobFamily / priority / allocationShare / targetCount / evidenceLevel / decisionGate / inputHash / status / 计数 等——这些由系统确定性生成，你无权返回。
4. 长度上限：headline / 各 title ≤ ${TITLE_MAX} 字符，objective ≤ ${OBJECTIVE_MAX}，summary ≤ ${SUMMARY_MAX}，rationale ≤ ${RATIONALE_MAX}，每条信号 / 不确定性 ≤ ${SIGNAL_MAX}；uncertainties / successSignals / failureSignals 最多 ${LIST_MAX} 项。
5. 绝对禁止建议直接降薪、放弃城市或职业方向、直接搬迁、辞职、自动投递；不得输出成功率 / Offer 概率 / 市场结论 / 样本充分等断言；样本不足时用"证据不足，尚待验证"一类表述。
6. 只输出 JSON。`;
}

export const STRATEGY_AI_SYSTEM_PROMPT = buildSystemPrompt();

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

待润色行动清单（actionNarratives 必须逐一对应这些 actionId，只补充叙事，不得增删）：
${JSON.stringify(snapshot.actionTargets)}

严格按下面这个 JSON 结构返回（示例仅表达结构与 actionId 对应关系，请替换为真实文案）：
\`\`\`json
${buildOverlayExampleJson(snapshot)}
\`\`\``;
}

function buildRepairUserMessage(snapshot: StrategyAiInputSnapshot, previousRawText: string, reason: string): string {
  return `你上一次返回的 JSON 未通过结构校验。错误位置与期望类型如下（path: 错误）：
${reason}

请只修复这些问题，不得新增系统未提供的行动或字段。特别注意：
- uncertainties / successSignals / failureSignals 必须是 JSON 数组，不能是字符串。
- 不得出现 citedEvidenceIds 或任何未定义字段。
- actionId 只能取自"待润色行动清单"。

以下是你上一次的原始输出（仅供你定位问题）：
\`\`\`
${previousRawText}
\`\`\`

必须严格返回如下结构（替换为真实文案后只输出 JSON）：
\`\`\`json
${buildOverlayExampleJson(snapshot)}
\`\`\``;
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

/**
 * 从 Zod 错误中提取安全摘要：只保留字段 path、错误类型与期望信息，
 * 不回显完整用户数据或完整 AI 输出，供修复请求与错误 details 使用。
 */
export function summarizeZodIssues(error: z.ZodError): string {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.join('.') || '<root>';
    const parts: string[] = [issue.code];
    const raw = issue as unknown as Record<string, unknown>;
    if (typeof raw.expected === 'string') parts.push(`expected=${raw.expected}`);
    if (typeof raw.received === 'string') parts.push(`received=${raw.received}`);
    if (typeof raw.maximum === 'number') parts.push(`max=${raw.maximum}`);
    if (Array.isArray(raw.keys)) parts.push(`keys=${(raw.keys as string[]).join(',')}`);
    return `${path}: ${parts.join(' ')}`;
  }).join('; ');
}

function collectNarrativeTexts(output: StrategyAiOutput): string[] {
  return [
    output.headline, output.objective, output.summary,
    ...output.uncertainties,
    ...output.actionNarratives.flatMap((entry) => [
      entry.title, entry.rationale, ...entry.successSignals, ...entry.failureSignals,
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
 * 解析并校验 AI 叙述 overlay：结构（strict，含未知字段/字符串化数组/长度）、禁止措辞、
 * actionId 引用三类问题都视为同一类"结构错误"，走同一次修复重试路径，
 * 绝不把未通过校验的输出当作半成品保存。错误只包含安全的字段 path 与类型摘要。
 */
export function parseStrategyAiOutput(
  rawText: string,
  allowedActionIds: readonly string[],
): { data: StrategyAiOutput } | { error: string } {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    return { error: `AI 输出不是合法 JSON：${(error as Error).message}` };
  }
  const result = StrategyAiOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `结构校验失败：${summarizeZodIssues(result.error)}` };
  }
  const allowedSet = new Set(allowedActionIds);
  const invalidActionId = result.data.actionNarratives.find((entry) => !allowedSet.has(entry.actionId));
  if (invalidActionId !== undefined) {
    return { error: `actionNarratives.actionId: unknown 引用了确定性草稿中不存在的行动` };
  }
  const forbidden = findForbiddenPhrase(collectNarrativeTexts(result.data));
  if (forbidden !== null) {
    return { error: `文案中出现禁止措辞："${forbidden}"` };
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
    const allowedActionIds = snapshot.actionTargets.map((target) => target.actionId);
    const first = await callModel(STRATEGY_AI_SYSTEM_PROMPT, buildFirstUserMessage(snapshot), signal);
    const firstCheck = parseStrategyAiOutput(first.rawText, allowedActionIds);
    if ('data' in firstCheck) return first;

    const second = await callModel(
      STRATEGY_AI_SYSTEM_PROMPT,
      buildRepairUserMessage(snapshot, first.rawText, firstCheck.error),
      signal,
    );
    const secondCheck = parseStrategyAiOutput(second.rawText, allowedActionIds);
    if ('data' in secondCheck) return second;

    throw new StrategyError(
      422,
      'STRATEGY_AI_OUTPUT_INVALID',
      'AI 连续两次未能生成符合安全约束的求职策略文案，请重新生成或使用手工提案',
      { reason: secondCheck.error, attempts: 2 },
    );
  },
};
