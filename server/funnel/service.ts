import { z } from 'zod';
import { aggregateFunnel } from '../../src/domain/funnel';
import type { FunnelResult } from '../../src/domain/funnel';
import type { SqliteDatabase } from '../db';
import { JobRepository } from '../repositories/jobRepository';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { validationError } from './errors';
import { FunnelQueryParamsSchema } from './dtoSchemas';

function parseDto<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw validationError(result.error);
  return result.data;
}

export interface FunnelServiceDeps {
  db: SqliteDatabase;
}

/**
 * 只读聚合服务：从正式 applications / feedback_events 投影计算基础漏斗，
 * 不持久化任何派生统计表，每次调用都重新查询与计算。
 */
export class FunnelService {
  private readonly jobs: JobRepository;
  private readonly applications: ApplicationRepository;
  private readonly events: FeedbackEventRepository;

  constructor(deps: FunnelServiceDeps) {
    this.jobs = new JobRepository(deps.db);
    this.applications = new ApplicationRepository(deps.db);
    this.events = new FeedbackEventRepository(deps.db);
  }

  getFunnel(queryInput: unknown): FunnelResult {
    const query = parseDto(FunnelQueryParamsSchema, queryInput ?? {});
    const jobsById = new Map(this.jobs.list().map((job) => [job.id, job]));
    const sources = this.applications.listApplications().map((application) => ({
      application,
      job: jobsById.get(application.jobId) ?? null,
      events: this.events.listEventsByApplication(application.id),
    }));
    return aggregateFunnel(sources, {
      city: query.city ?? null,
      roleFamily: query.roleFamily ?? null,
      channel: query.channel ?? null,
      resumeVersionId: query.resumeVersionId ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      timeGranularity: query.timeGranularity ?? 'none',
    });
  }
}
