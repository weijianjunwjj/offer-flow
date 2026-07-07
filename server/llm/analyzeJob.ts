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

const SYSTEM_PROMPT = `你是一位资深求职顾问，擅长分析技术岗位 JD 并为求职者提供决策建议。

请严格按照以下要求输出：
1. 先用 Markdown 写一份给人看的分析报告
2. 然后在报告末尾，用 ---OFFER_FLOW_JSON_START--- 和 ---OFFER_FLOW_JSON_END--- 包裹一个 JSON 数据块
3. JSON 格式参考示例中的字段结构
4. 所有分数为 0-100 整数
5. 枚举值必须使用示例中指定的合法值
6. 不要编造不存在的字段`;

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

  const userMessage = buildAnalysisPrompt(
    input.profile ?? null,
    {
      company: input.company,
      role: input.role,
      city: input.city,
      salaryRange: input.salaryRange,
      jdText: input.jdText,
    },
    input.companyInput ?? {
      sizeTier: 'unknown',
      staffRange: '',
      companyType: '',
      financingStage: '',
      commuteTime: '',
      commuteWay: '',
      companyNote: '',
      opportunityNote: '',
    },
  );

  const result = await chatCompletion(SYSTEM_PROMPT, userMessage);

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