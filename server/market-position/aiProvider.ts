import { z } from 'zod';
import { MARKET_POSITION_CITY_CODES, type MarketPositionCityCode } from '../../src/domain/market-position';
import { chatCompletion, getLlmConfig, isLlmConfigured } from '../llm/provider';
import { MarketPositionError } from './errors';

const nonBlank = z.string().trim().min(1).max(160);
const shortList = z.array(nonBlank).max(6);

const narrativeShape = {
  headline: nonBlank,
  positioning: nonBlank,
  observedStrengths: shortList,
  observedWeaknesses: shortList,
  marketSignals: shortList,
  counterSignals: shortList,
  uncertainties: shortList,
  nextEvidenceActions: shortList,
  citedEvidenceIds: z.array(z.string().trim().min(1).max(200)).max(10),
};

export const MarketPositionAiScopeNarrativeSchema = z.strictObject(narrativeShape);
export type MarketPositionAiScopeNarrative = z.infer<typeof MarketPositionAiScopeNarrativeSchema>;

export const MarketPositionAiOutputSchema = z.strictObject({
  global: MarketPositionAiScopeNarrativeSchema,
  cityProfiles: z.array(z.strictObject({
    city: z.enum(MARKET_POSITION_CITY_CODES),
    ...narrativeShape,
  })).length(MARKET_POSITION_CITY_CODES.length),
}).superRefine((value, context) => {
  const cities = value.cityProfiles.map(({ city }) => city);
  for (const city of MARKET_POSITION_CITY_CODES) {
    if (cities.filter((candidate) => candidate === city).length !== 1) {
      context.addIssue({ code: 'custom', path: ['cityProfiles'], message: `城市 ${city} 必须且只能出现一次` });
    }
  }
});

export type MarketPositionAiOutput = z.infer<typeof MarketPositionAiOutputSchema>;

/** AI 叙述文本中任何情况下不得出现的措辞，命中即视为结构错误（不区分证据等级）。 */
const FORBIDDEN_PHRASES = [
  '市场不认可', '竞争力很差', '应该降薪', '应该放弃', '不适合你', '机会一定更大',
  '应立即迁移', '已经失败', '回复率', '成功率', 'offer概率', 'offer 概率', '概率预测',
  '科学证明', '样本充分', '市场结论',
];

export interface MarketPositionAiScopeFacts {
  scopeLabel: string;
  city: MarketPositionCityCode | null;
  evidenceLevel: string;
  allowedClaims: string[];
  blockedClaims: string[];
  applicationCount: number;
  companyCount: number;
  validReplyCount: number;
  interviewCount: number;
  terminalOutcomeCount: number;
  hasAnyEvidence: boolean;
}

export interface MarketPositionAiInputSnapshot {
  acceptedEvidenceIds: string[];
  global: MarketPositionAiScopeFacts;
  cityProfiles: MarketPositionAiScopeFacts[];
}

export interface MarketPositionAiProvider {
  isConfigured(): boolean;
  modelName(): string;
  generate(snapshot: MarketPositionAiInputSnapshot, signal?: AbortSignal): Promise<{
    rawText: string;
    model: string;
  }>;
}

const GENERATION_MAX_TOKENS = 4096;

const NO_DATA_DISCLOSURE = '当前没有该城市的正式市场反馈，不能判断该城市是否适合你。';

function buildOutputTemplateJson(): string {
  const narrative = {
    headline: '',
    positioning: '',
    observedStrengths: [],
    observedWeaknesses: [],
    marketSignals: [],
    counterSignals: [],
    uncertainties: [],
    nextEvidenceActions: [],
    citedEvidenceIds: [],
  };
  return JSON.stringify({
    global: narrative,
    cityProfiles: MARKET_POSITION_CITY_CODES.map((city) => ({ city, ...narrative })),
  }, null, 2);
}

function buildSystemPrompt(): string {
  const template = buildOutputTemplateJson();
  return `你是 OfferFlow 的市场位置提案文案助手。只输出一个合法 JSON 对象，不输出 Markdown、不输出代码块、不输出任何解释文字。

严格 JSON 结构模板（仅表达字段结构，禁止原样返回空字符串或占位内容）：
\`\`\`
${template}
\`\`\`

你的职责仅限于撰写中文叙述性文案，绝不允许输出或推断以下任何内容（即使模板中不存在这些字段，也不得在文本中给出具体数值或结论）：
- 任何投递数、回复数、面试数、终态数或百分比数字
- 证据充分性等级、决策门状态
- 任何"市场结论""样本充分""成功率/概率/Offer 概率"类断言
- 城市不适合、城市排名、放弃方向、降薪、搬迁等指令性结论

输出契约：
1. cityProfiles 必须且只能包含 suzhou、wuxi、shanghai、hangzhou 四个城市，且各恰好一次。
2. 每个城市与 global 都必须填写完整字段，不能省略也不能新增字段。
3. citedEvidenceIds 只能填写下方"可引用证据 ID 清单"中真实存在的 ID；没有可引用证据时留空数组，禁止编造 ID。
4. 一个城市如果没有正式市场反馈（下方会明确标注"无正式市场数据"），headline 和 positioning 必须原文使用："${NO_DATA_DISCLOSURE}"，其余数组字段留空。
5. 不同城市之间不得混用彼此的市场信号；每个城市的叙述只能基于该城市自身给出的证据等级与事实描述。
6. 样本不足时使用"证据不足，尚待验证"一类表述，不得给出负面市场结论（例如不得说"0% 回复率"或"市场不认可"）。
7. 每条文本字段不超过约 80 个中文字符，数组字段最多 6 项。
8. 只输出 JSON，不输出 Markdown、不输出代码块、不输出解释性文字。`;
}

export const MARKET_POSITION_PROMPT_VERSION = 'market-position-ai-v1';
export const MARKET_POSITION_AI_SYSTEM_PROMPT = buildSystemPrompt();

const REPAIR_INSTRUCTION = `你上一次返回的 JSON 使用了错误结构，或引用了不存在的证据 ID，或出现了禁止措辞。
只修复字段结构、citedEvidenceIds 引用与禁止措辞问题，不得新增输入快照中不存在的事实。
无正式市场数据的城市必须使用固定的"无数据"表述。
只返回修复后的 JSON。`;

function describeScope(facts: MarketPositionAiScopeFacts): string {
  return JSON.stringify({
    scopeLabel: facts.scopeLabel,
    city: facts.city,
    evidenceLevel: facts.evidenceLevel,
    allowedClaims: facts.allowedClaims,
    blockedClaims: facts.blockedClaims,
    hasAnyEvidence: facts.hasAnyEvidence,
  });
}

function buildFirstUserMessage(snapshot: MarketPositionAiInputSnapshot): string {
  return `请基于以下只读事实快照为 global 与四个城市分别撰写市场位置叙述文案。
可引用证据 ID 清单（citedEvidenceIds 只能从此清单中选取，不得编造）：
${JSON.stringify(snapshot.acceptedEvidenceIds)}

global 事实：${describeScope(snapshot.global)}

城市事实：
${snapshot.cityProfiles.map((facts) => describeScope(facts)).join('\n')}`;
}

function buildRepairUserMessage(
  snapshot: MarketPositionAiInputSnapshot,
  previousRawText: string,
  reason: string,
): string {
  const template = buildOutputTemplateJson();
  return `以下是你上一次的原始输出：
\`\`\`
${previousRawText}
\`\`\`

结构或安全校验错误：
${reason}

当前完整输出模板：
\`\`\`
${template}
\`\`\`

原始只读事实快照：
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

function collectNarrativeTexts(output: MarketPositionAiOutput): string[] {
  const scopes = [output.global, ...output.cityProfiles];
  return scopes.flatMap((scope) => [
    scope.headline, scope.positioning,
    ...scope.observedStrengths, ...scope.observedWeaknesses,
    ...scope.marketSignals, ...scope.counterSignals,
    ...scope.uncertainties, ...scope.nextEvidenceActions,
  ]);
}

function findForbiddenPhrase(texts: string[]): string | null {
  for (const text of texts) {
    for (const phrase of FORBIDDEN_PHRASES) {
      if (text.includes(phrase)) return phrase;
    }
  }
  return null;
}

function findInvalidEvidenceId(output: MarketPositionAiOutput, allowedIds: readonly string[]): string | null {
  const allowedSet = new Set(allowedIds);
  const scopes = [output.global, ...output.cityProfiles];
  for (const scope of scopes) {
    for (const id of scope.citedEvidenceIds) {
      if (!allowedSet.has(id)) return id;
    }
  }
  return null;
}

/**
 * 解析并校验 AI 叙述输出：结构、禁止措辞、证据引用三类问题都视为同一类"结构错误"，
 * 走同一次修复重试路径，绝不把未通过校验的输出当作半成品保存。
 */
export function parseMarketPositionAiOutput(
  rawText: string,
  allowedEvidenceIds: readonly string[],
): { data: MarketPositionAiOutput } | { error: string } {
  let parsed: unknown;
  try {
    parsed = extractJson(rawText);
  } catch (error) {
    return { error: `AI 输出不是合法 JSON：${(error as Error).message}` };
  }
  const result = MarketPositionAiOutputSchema.safeParse(parsed);
  if (!result.success) {
    return { error: `结构校验失败：${JSON.stringify(result.error.issues.map((issue) => issue.message))}` };
  }
  const forbidden = findForbiddenPhrase(collectNarrativeTexts(result.data));
  if (forbidden !== null) {
    return { error: `文案中出现禁止措辞："${forbidden}"` };
  }
  const invalidId = findInvalidEvidenceId(result.data, allowedEvidenceIds);
  if (invalidId !== null) {
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
    if (result.error.includes('超时')) {
      throw new MarketPositionError(503, 'MARKET_POSITION_AI_UNAVAILABLE', result.error);
    }
    throw new MarketPositionError(503, 'MARKET_POSITION_AI_UNAVAILABLE', result.error);
  }
  return { rawText: result.rawText, model: result.model };
}

export const deepSeekMarketPositionProvider: MarketPositionAiProvider = {
  isConfigured: isLlmConfigured,
  modelName: () => getLlmConfig().model || 'unknown',
  async generate(snapshot, signal) {
    const first = await callModel(MARKET_POSITION_AI_SYSTEM_PROMPT, buildFirstUserMessage(snapshot), signal);
    const firstCheck = parseMarketPositionAiOutput(first.rawText, snapshot.acceptedEvidenceIds);
    if ('data' in firstCheck) return first;

    const second = await callModel(
      MARKET_POSITION_AI_SYSTEM_PROMPT,
      buildRepairUserMessage(snapshot, first.rawText, firstCheck.error),
      signal,
    );
    const secondCheck = parseMarketPositionAiOutput(second.rawText, snapshot.acceptedEvidenceIds);
    if ('data' in secondCheck) return second;

    throw new MarketPositionError(
      422,
      'MARKET_POSITION_AI_OUTPUT_INVALID',
      'AI 连续两次未能生成符合安全约束的市场位置文案，请重新生成或使用手工提案',
      { reason: secondCheck.error, attempts: 2 },
    );
  },
};
