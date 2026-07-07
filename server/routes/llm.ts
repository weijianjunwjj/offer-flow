import type { FastifyInstance } from 'fastify';
import { JobRepository } from '../repositories/jobRepository.js';
import { analyzeJob, type AnalyzeJobOutput } from '../llm/analyzeJob.js';
import {
  isLlmConfigured,
  getMissingLlmConfigFields,
  chatCompletionStream,
} from '../llm/provider.js';
import { buildAnalysisPrompt } from '../../src/app/prompt.js';
import {
  extractOfferFlowJson,
  parseOfferFlowJson,
  type ParsedOfferFlowResult,
} from '../../src/app/offerFlowJson.js';

interface AnalyzeJobRequest {
  jobId?: string;
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
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

      let company = '';
      let role = '';
      let city = '';
      let salaryRange = '';
      let jdText = '';

      if (body.jobId) {
        const repo = new JobRepository(app.db);
        const job = repo.get(body.jobId);
        if (!job) {
          return reply.code(404).send({
            rawText: '',
            parsed: null,
            parseStatus: 'error',
            error: `岗位不存在: ${body.jobId}`,
            model: 'unknown',
            createdAt: Date.now(),
          } satisfies AnalyzeJobOutput);
        }
        company = job.company;
        role = job.role;
        city = job.city;
        salaryRange = job.salaryRange;
        jdText = job.jdText;
      } else {
        company = body.company ?? '';
        role = body.role ?? '';
        city = body.city ?? '';
        salaryRange = body.salaryRange ?? '';
        jdText = body.jdText ?? '';
      }

      if (jdText.trim() === '') {
        return reply.code(400).send({
          rawText: '',
          parsed: null,
          parseStatus: 'error',
          error: 'JD 文本为空，无法分析',
          model: 'unknown',
          createdAt: Date.now(),
        } satisfies AnalyzeJobOutput);
      }

      const result = await analyzeJob({
        company,
        role,
        city,
        salaryRange,
        jdText,
      });

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

    let company = '';
    let role = '';
    let city = '';
    let salaryRange = '';
    let jdText = '';

    if (body.jobId) {
      const repo = new JobRepository(app.db);
      const job = repo.get(body.jobId);
      if (!job) {
        return reply.code(404).send({
          rawText: '',
          parsed: null,
          parseStatus: 'error',
          error: `岗位不存在: ${body.jobId}`,
          model: 'unknown',
          createdAt: Date.now(),
        } satisfies AnalyzeJobOutput);
      }
      company = job.company;
      role = job.role;
      city = job.city;
      salaryRange = job.salaryRange;
      jdText = job.jdText;
    } else {
      company = body.company ?? '';
      role = body.role ?? '';
      city = body.city ?? '';
      salaryRange = body.salaryRange ?? '';
      jdText = body.jdText ?? '';
    }

    if (jdText.trim() === '') {
      return reply.code(400).send({
        rawText: '',
        parsed: null,
        parseStatus: 'error',
        error: 'JD 文本为空，无法分析',
        model: 'unknown',
        createdAt: Date.now(),
      } satisfies AnalyzeJobOutput);
    }

    const SYSTEM_PROMPT = `你是 OfferFlow 的岗位分析助手。请基于用户提供的求职背景和 JD，输出一份简洁岗位分析。
输出要求：
1. 先输出 Markdown 简报，最多 5 段，每段不超过 3 行。
2. 然后输出 OFFER_FLOW_JSON 数据块，必须使用 ---OFFER_FLOW_JSON_START--- 和 ---OFFER_FLOW_JSON_END--- 包裹。
3. JSON 字段必须兼容现有 OfferFlow 解析器。
4. 分数使用 0-100 整数。
5. 不要输出与岗位无关的长篇建议。
6. 不要编造 JD 中没有的信息。`;

    const userMessage = buildAnalysisPrompt(
      null,
      { company, role, city, salaryRange, jdText },
      {
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
      const stream = chatCompletionStream(SYSTEM_PROMPT, userMessage);
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
