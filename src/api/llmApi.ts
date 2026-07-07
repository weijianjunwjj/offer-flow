import type { ParsedOfferFlowResult } from '../app/offerFlowJson';
import { apiSend } from './client';

export interface AnalyzeJobRequest {
  jobId?: string;
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
}

export interface AnalyzeJobResponse {
  rawText: string;
  parsed: ParsedOfferFlowResult | null;
  parseStatus: 'success' | 'not_found' | 'invalid_json' | 'partial' | 'error';
  error: string;
  model: string;
  createdAt: number;
}

export const llmApi = {
  analyzeJob(input: AnalyzeJobRequest): Promise<AnalyzeJobResponse> {
    return apiSend<AnalyzeJobResponse>('/api/llm/analyze-job', 'POST', input);
  },
};