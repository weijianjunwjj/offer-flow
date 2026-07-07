import type { FastifyInstance } from 'fastify';
import { JobRepository } from '../repositories/jobRepository.js';
import { analyzeJob, type AnalyzeJobOutput } from '../llm/analyzeJob.js';
import { isLlmConfigured, getMissingLlmConfigFields } from '../llm/provider.js';

interface AnalyzeJobRequest {
  jobId?: string;
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
}

export function registerLlmRoutes(app: FastifyInstance): void {
  app.post('/api/llm/analyze-job', async (request, reply): Promise<AnalyzeJobOutput> => {
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
  });
}