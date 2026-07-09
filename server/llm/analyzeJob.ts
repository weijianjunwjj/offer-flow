import { buildAnalysisPrompt } from '../../src/app/prompt.js';
import {
  extractOfferFlowJson,
  parseOfferFlowJson,
  type ParsedOfferFlowResult,
} from '../../src/app/offerFlowJson.js';
import type { JobSeekerProfile, CompanyInput } from '../../src/storage/index.js';
import { chatCompletion, isLlmConfigured, getMissingLlmConfigFields } from './provider.js';

export interface AnalyzeJobInput {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
  companyInput?: CompanyInput;
  profile?: JobSeekerProfile | null;
}

export interface AnalyzeJobOutput {
  rawText: string;
  parsed: ParsedOfferFlowResult | null;
  parseStatus: 'success' | 'not_found' | 'invalid_json' | 'partial' | 'error';
  error: string;
  model: string;
  createdAt: number;
}

export const ANALYZE_JOB_SYSTEM_PROMPT = `你是 OfferFlow 的岗位分析助手。请基于用户提供的求职背景和 JD，输出一份简洁岗位分析。
输出要求：
1. 先输出 Markdown 简报，最多 5 段，每段不超过 3 行。
2. 然后输出 OFFER_FLOW_JSON 数据块，必须使用 ---OFFER_FLOW_JSON_START--- 和 ---OFFER_FLOW_JSON_END--- 包裹。
3. JSON 字段必须兼容现有 OfferFlow 解析器。
4. 分数使用 0-100 整数。
5. 不要输出与岗位无关的长篇建议。
6. 不要编造 JD 中没有的信息。`;

const EMPTY_COMPANY_INPUT: CompanyInput = {
  sizeTier: 'unknown',
  staffRange: '',
  companyType: '',
  financingStage: '',
  commuteTime: '',
  commuteWay: '',
  companyNote: '',
  opportunityNote: '',
};

/**
 * 由 analyze-job 的非流式和流式路由共用，保证两条路径使用同一套 profile / companyInput 构造逻辑。
 */
export function buildAnalyzeJobPrompt(input: AnalyzeJobInput): string {
  return buildAnalysisPrompt(
    input.profile ?? null,
    {
      company: input.company,
      role: input.role,
      city: input.city,
      salaryRange: input.salaryRange,
      jdText: input.jdText,
    },
    input.companyInput ?? EMPTY_COMPANY_INPUT,
  );
}

export async function analyzeJob(input: AnalyzeJobInput): Promise<AnalyzeJobOutput> {
  const createdAt = Date.now();

  if (!isLlmConfigured()) {
    const missing = getMissingLlmConfigFields();
    return {
      rawText: '',
      parsed: null,
      parseStatus: 'error',
      error: `LLM 未配置：缺少 ${missing.join(', ')}。请设置 OFFERFLOW_LLM_${missing.join(' / OFFERFLOW_LLM_')}（或对应的 DEEPSEEK_* 变量）`,
      model: 'unknown',
      createdAt,
    };
  }

  const userMessage = buildAnalyzeJobPrompt(input);

  const result = await chatCompletion(ANALYZE_JOB_SYSTEM_PROMPT, userMessage);

  if (result.error) {
    return {
      rawText: result.rawText,
      parsed: null,
      parseStatus: 'error',
      error: result.error,
      model: result.model,
      createdAt,
    };
  }

  const jsonText = extractOfferFlowJson(result.rawText);
  const parsed: ParsedOfferFlowResult | null = jsonText
    ? parseOfferFlowJson(jsonText)
    : { status: 'not_found', matchScore: '', companyAssessment: null, opportunityAnalysis: null, warnings: ['未找到 OFFER_FLOW_JSON 数据块'] };

  return {
    rawText: result.rawText,
    parsed,
    parseStatus: parsed?.status ?? 'not_found',
    error: '',
    model: result.model,
    createdAt,
  };
}