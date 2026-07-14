import {
  JobMatchProfileDraftSchema,
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

export const JOB_MATCH_PROFILE_SYSTEM_PROMPT = `你是 OfferFlow 的岗位匹配画像提案助手。只输出一个合法 JSON 对象，不输出 Markdown。
严格规则：
1. 不要因为短期无回复下调岗位定位、薪资或能力评价。
2. 不要跨城市混合薪资、回复率、岗位供给、学历门槛或公司规模结论。
3. 没有证据时必须写入 missingEvidence 或 largestUncertainties，并使用 insufficient/exploratory。
4. 不要编造公司、岗位、工资、面试、拒绝或学历事实。
5. 必须区分冲刺岗位、主攻岗位和稳妥岗位。
6. 必须列出支持证据、相反证据和缺失证据。
7. cityProfiles 必须且只能包含 suzhou、wuxi、shanghai、hangzhou 各一次。
8. 所有展示性文本使用中文，证据引用只能使用输入中真实存在的来源 ID，或使用 sourceType=user_input/sourceId=null。
9. 输出必须符合 JobMatchProfileDraft 的严格结构，不得增加未知字段。`;

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

export const deepSeekJobMatchProfileProvider: JobMatchProfileAiProvider = {
  isConfigured: isLlmConfigured,
  modelName: () => getLlmConfig().model || 'unknown',
  async generate(snapshot, signal) {
    const result = await chatCompletion(
      JOB_MATCH_PROFILE_SYSTEM_PROMPT,
      `请基于以下只读输入快照生成岗位匹配画像提案：\n${JSON.stringify(snapshot)}`,
      { maxTokens: 4096, temperature: 0.1, signal },
    );
    if (result.error) {
      if (result.error.includes('超时')) {
        throw new JobMatchProfileError(503, 'AI_PROVIDER_TIMEOUT', result.error);
      }
      throw new JobMatchProfileError(503, 'AI_PROVIDER_UNAVAILABLE', result.error);
    }
    return { rawText: result.rawText, model: result.model };
  },
};
