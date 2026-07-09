import type { FastifyInstance } from 'fastify';
import { JobRepository } from '../repositories/jobRepository.js';
import { ProfileRepository } from '../repositories/profileRepository.js';
import {
  analyzeJob,
  buildAnalyzeJobPrompt,
  ANALYZE_JOB_SYSTEM_PROMPT,
  type AnalyzeJobInput,
  type AnalyzeJobOutput,
} from '../llm/analyzeJob.js';
import {
  isLlmConfigured,
  getMissingLlmConfigFields,
  chatCompletionStream,
} from '../llm/provider.js';
import {
  extractOfferFlowJson,
  parseOfferFlowJson,
  type ParsedOfferFlowResult,
} from '../../src/app/offerFlowJson.js';
import type { CompanyInput } from '../../src/storage/index.js';

interface AnalyzeJobRequest {
  jobId?: string;
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
  companyInput?: CompanyInput;
}

/**
 * jobId 存在时以数据库中的岗位记录（含 companyInput）为准，否则用请求体里的临时字段兜底。
 * profile 始终读取本地已保存的求职者画像，非流式与流式路径共用同一份输入。
 */
function resolveAnalyzeJobInput(
  app: FastifyInstance,
  body: AnalyzeJobRequest,
): { input: AnalyzeJobInput } | { errorCode: number; error: string } {
  let company = '';
  let role = '';
  let city = '';
  let salaryRange = '';
  let jdText = '';
  let companyInput: CompanyInput | undefined = body.companyInput;

  if (body.jobId) {
    const repo = new JobRepository(app.db);
    const job = repo.get(body.jobId);
    if (!job) {
      return { errorCode: 404, error: `岗位不存在: ${body.jobId}` };
    }
    company = job.company;
    role = job.role;
    city = job.city;
    salaryRange = job.salaryRange;
    jdText = job.jdText;
    companyInput = job.companyInput;
  } else {
    company = body.company ?? '';
    role = body.role ?? '';
    city = body.city ?? '';
    salaryRange = body.salaryRange ?? '';
    jdText = body.jdText ?? '';
  }

  if (jdText.trim() === '') {
    return { errorCode: 400, error: 'JD 文本为空，无法分析' };
  }

  const profile = new ProfileRepository(app.db).get();

  return {
    input: { company, role, city, salaryRange, jdText, companyInput, profile },
  };
}

export function registerLlmRoutes(app: FastifyInstance): void {
  app.post(
    '/api/llm/analyze-job',
    async (request, reply): Promise<AnalyzeJobOutput> => {
      const body = request.body as AnalyzeJobRequest;

      if (!isLlmConfigured()) {
        const missing = getMissingLlmConfigFields();
        return reply.code(400).send({
          rawText: '',
          parsed: null,
          parseStatus: 'error',
          error: `LLM 未配置：缺少 ${missing.join(', ')}。请设置 OFFERFLOW_LLM_${missing.join(' / OFFERFLOW_LLM_')}（或对应的 DEEPSEEK_* 变量）`,
          model: 'unknown',
          createdAt: Date.now(),
        } satisfies AnalyzeJobOutput);
      }

      const resolved = resolveAnalyzeJobInput(app, body);
      if ('errorCode' in resolved) {
        return reply.code(resolved.errorCode).send({
          rawText: '',
          parsed: null,
          parseStatus: 'error',
          error: resolved.error,
          model: 'unknown',
          createdAt: Date.now(),
        } satisfies AnalyzeJobOutput);
      }

      const result = await analyzeJob(resolved.input);

      return result;
    },
  );

  app.post('/api/llm/analyze-job-stream', async (request, reply) => {
    const body = request.body as AnalyzeJobRequest;

    if (!isLlmConfigured()) {
      const missing = getMissingLlmConfigFields();
      return reply.code(400).send({
        rawText: '',
        parsed: null,
        parseStatus: 'error',
        error: `LLM 未配置：缺少 ${missing.join(', ')}。请设置 OFFERFLOW_LLM_${missing.join(' / OFFERFLOW_LLM_')}（或对应的 DEEPSEEK_* 变量）`,
        model: 'unknown',
        createdAt: Date.now(),
      } satisfies AnalyzeJobOutput);
    }

    const resolved = resolveAnalyzeJobInput(app, body);
    if ('errorCode' in resolved) {
      return reply.code(resolved.errorCode).send({
        rawText: '',
        parsed: null,
        parseStatus: 'error',
        error: resolved.error,
        model: 'unknown',
        createdAt: Date.now(),
      } satisfies AnalyzeJobOutput);
    }

    const userMessage = buildAnalyzeJobPrompt(resolved.input);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    });

    const createdAt = Date.now();
    let fullText = '';

    try {
      const stream = chatCompletionStream(ANALYZE_JOB_SYSTEM_PROMPT, userMessage);
      let result = await stream.next();

      while (!result.done) {
        const chunk = result.value;
        if (chunk && !chunk.done) {
          fullText += chunk.content;
          reply.raw.write(
            `data: ${JSON.stringify({ type: 'chunk', content: chunk.content })}\n\n`,
          );
        }
        result = await stream.next();
      }

      const llmResult = result.value;

      if (llmResult.error) {
        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'error',
            rawText: fullText,
            parsed: null,
            parseStatus: 'error',
            error: llmResult.error,
            model: llmResult.model,
            createdAt,
          })}\n\n`,
        );
      } else {
        const jsonText = extractOfferFlowJson(llmResult.rawText);
        const parsed: ParsedOfferFlowResult | null = jsonText
          ? parseOfferFlowJson(jsonText)
          : {
              status: 'not_found',
              matchScore: '',
              companyAssessment: null,
              opportunityAnalysis: null,
              warnings: ['未找到 OFFER_FLOW_JSON 数据块'],
            };

        reply.raw.write(
          `data: ${JSON.stringify({
            type: 'done',
            rawText: llmResult.rawText,
            parsed,
            parseStatus: parsed?.status ?? 'not_found',
            error: '',
            model: llmResult.model,
            createdAt,
          })}\n\n`,
        );
      }
    } catch (error) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: 'error',
          rawText: fullText,
          parsed: null,
          parseStatus: 'error',
          error: `流式响应异常: ${(error as Error).message}`,
          model: 'unknown',
          createdAt,
        })}\n\n`,
      );
    }

    reply.raw.end();
  });
}
