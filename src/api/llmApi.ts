import type { ParsedOfferFlowResult } from '../app/offerFlowJson';
import { apiSend, buildApiUrl } from './client';

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

export interface StreamEvent {
  type: 'chunk' | 'done' | 'error';
  content?: string;
  rawText?: string;
  parsed?: ParsedOfferFlowResult | null;
  parseStatus?: string;
  error?: string;
  model?: string;
  createdAt?: number;
}

export const llmApi = {
  analyzeJob(input: AnalyzeJobRequest): Promise<AnalyzeJobResponse> {
    return apiSend<AnalyzeJobResponse>('/api/llm/analyze-job', 'POST', input);
  },

  async *analyzeJobStream(input: AnalyzeJobRequest): AsyncGenerator<StreamEvent, AnalyzeJobResponse> {
    const response = await fetch(buildApiUrl('/api/llm/analyze-job-stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => null);
      const errorResult: AnalyzeJobResponse = {
        rawText: '',
        parsed: null,
        parseStatus: 'error',
        error: errorJson?.error ?? `HTTP ${response.status}`,
        model: 'unknown',
        createdAt: Date.now(),
      };
      return errorResult;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const errorResult: AnalyzeJobResponse = {
        rawText: '',
        parsed: null,
        parseStatus: 'error',
        error: '流式响应体为空',
        model: 'unknown',
        createdAt: Date.now(),
      };
      return errorResult;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: AnalyzeJobResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        try {
          const event = JSON.parse(data) as StreamEvent & AnalyzeJobResponse;
          if (event.type === 'chunk') {
            yield event;
          } else if (event.type === 'done') {
            finalResult = {
              rawText: event.rawText ?? '',
              parsed: event.parsed ?? null,
              parseStatus: (event.parseStatus as AnalyzeJobResponse['parseStatus']) ?? 'not_found',
              error: event.error ?? '',
              model: event.model ?? 'unknown',
              createdAt: event.createdAt ?? Date.now(),
            };
          } else if (event.type === 'error') {
            finalResult = {
              rawText: event.rawText ?? '',
              parsed: event.parsed ?? null,
              parseStatus: (event.parseStatus as AnalyzeJobResponse['parseStatus']) ?? 'error',
              error: event.error ?? '',
              model: event.model ?? 'unknown',
              createdAt: event.createdAt ?? Date.now(),
            };
          }
        } catch {
          // skip unparseable lines
        }
      }
    }

    if (finalResult) {
      return finalResult;
    }

    const errorResult: AnalyzeJobResponse = {
      rawText: '',
      parsed: null,
      parseStatus: 'error',
      error: '流式响应未返回最终结果',
      model: 'unknown',
      createdAt: Date.now(),
    };
    return errorResult;
  },
};