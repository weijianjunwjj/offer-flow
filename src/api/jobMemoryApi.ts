import { z } from 'zod';
import {
  JobDetailBundleV2Schema,
  JobMemoryBundleSchema,
  JobSummariesResponseSchema,
  type JobDetailBundleV2,
  type JobMemoryBundle,
  type JobSummary,
} from '../domain/job-memory';
import type {
  AppendFeedbackEventRequest,
  CreateApplicationRequest,
  UpdateApplicationMetadataRequest,
  VoidFeedbackEventRequest,
  VoidApplicationRequest,
} from '../../server/job-memory/dtoSchemas';
import { ApiError, apiGet, apiSend, type ReadOptions } from './client';

const ApiErrorBodySchema = z.strictObject({
  code: z.string().trim().min(1),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  currentVersion: z.number().int().positive().optional(),
  existingId: z.string().trim().min(1).optional(),
});

export type ApplicationApiErrorCode =
  | 'JOB_NOT_FOUND'
  | 'APPLICATION_NOT_FOUND'
  | 'FEEDBACK_EVENT_NOT_FOUND'
  | 'RESUME_VERSION_NOT_FOUND'
  | 'ARCHIVED_RESUME_NOT_SELECTABLE'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'APPLICATION_ALREADY_VOIDED'
  | 'EVENT_ALREADY_VOIDED'
  | 'AUDIT_EVENT_NOT_USER_CREATABLE'
  | 'INVALID_REPLACEMENT_EVENT'
  | 'NO_EFFECTIVE_CHANGE'
  | 'VALIDATION_ERROR'
  | 'BUSINESS_RULE_VIOLATION'
  | 'INTERNAL_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR';

const stableCodes = new Set<ApplicationApiErrorCode>([
  'JOB_NOT_FOUND',
  'APPLICATION_NOT_FOUND',
  'FEEDBACK_EVENT_NOT_FOUND',
  'RESUME_VERSION_NOT_FOUND',
  'ARCHIVED_RESUME_NOT_SELECTABLE',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'APPLICATION_ALREADY_VOIDED',
  'EVENT_ALREADY_VOIDED',
  'AUDIT_EVENT_NOT_USER_CREATABLE',
  'INVALID_REPLACEMENT_EVENT',
  'NO_EFFECTIVE_CHANGE',
  'VALIDATION_ERROR',
  'BUSINESS_RULE_VIOLATION',
  'INTERNAL_ERROR',
]);

export class ApplicationApiError extends Error {
  constructor(
    readonly code: ApplicationApiErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly fieldErrors?: Record<string, string[]>,
    readonly currentVersion?: number,
    readonly existingId?: string,
  ) {
    super(message);
    this.name = 'ApplicationApiError';
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationApiError('INVALID_RESPONSE', '服务端返回了无法识别的求职流程数据');
  }
  return parsed.data;
}

function normalizeError(error: unknown): never {
  if (error instanceof ApplicationApiError) throw error;
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (error instanceof ApiError) {
    const parsed = ApiErrorBodySchema.safeParse(error.body);
    if (parsed.success && stableCodes.has(parsed.data.code as ApplicationApiErrorCode)) {
      const body = parsed.data;
      const code = body.code as ApplicationApiErrorCode;
      throw new ApplicationApiError(
        code,
        code === 'INTERNAL_ERROR' ? '求职流程存储暂时不可用' : body.message,
        error.status,
        body.fieldErrors,
        body.currentVersion,
        body.existingId,
      );
    }
    if (error.status >= 500) {
      throw new ApplicationApiError('INTERNAL_ERROR', '求职流程存储暂时不可用', error.status);
    }
    throw new ApplicationApiError('HTTP_ERROR', `求职流程请求失败（${error.status}）`, error.status);
  }
  throw new ApplicationApiError('NETWORK_ERROR', '无法连接求职流程服务，请检查临时联调服务是否启动');
}

async function request<T>(operation: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  try {
    return parseResponse(schema, await operation());
  } catch (error) {
    normalizeError(error);
  }
}

export const jobMemoryApi = {
  getJobDetailBundle(jobId: string, options?: ReadOptions): Promise<JobDetailBundleV2> {
    return request(
      () => apiGet<unknown>(`/jobs/${encodeURIComponent(jobId)}/bundle`, options),
      JobDetailBundleV2Schema,
    );
  },
  getJobSummaries(options?: ReadOptions): Promise<JobSummary[]> {
    return request(() => apiGet<unknown>('/jobs/summaries', options), JobSummariesResponseSchema);
  },
  createApplication(jobId: string, input: CreateApplicationRequest): Promise<JobMemoryBundle> {
    return request(
      () => apiSend<unknown>(`/jobs/${encodeURIComponent(jobId)}/applications`, 'POST', input),
      JobMemoryBundleSchema,
    );
  },
  updateApplication(
    applicationId: string,
    input: UpdateApplicationMetadataRequest,
  ): Promise<JobMemoryBundle> {
    return request(
      () => apiSend<unknown>(`/applications/${encodeURIComponent(applicationId)}`, 'PATCH', input),
      JobMemoryBundleSchema,
    );
  },
  voidApplication(applicationId: string, input: VoidApplicationRequest): Promise<JobMemoryBundle> {
    return request(
      () => apiSend<unknown>(`/applications/${encodeURIComponent(applicationId)}/void`, 'POST', input),
      JobMemoryBundleSchema,
    );
  },
  appendFeedbackEvent(
    applicationId: string,
    input: AppendFeedbackEventRequest,
  ): Promise<JobMemoryBundle> {
    return request(
      () => apiSend<unknown>(`/applications/${encodeURIComponent(applicationId)}/events`, 'POST', input),
      JobMemoryBundleSchema,
    );
  },
  voidFeedbackEvent(eventId: string, input: VoidFeedbackEventRequest): Promise<JobMemoryBundle> {
    return request(
      () => apiSend<unknown>(`/feedback-events/${encodeURIComponent(eventId)}/void`, 'POST', input),
      JobMemoryBundleSchema,
    );
  },
};

export type ApplicationApiPort = typeof jobMemoryApi;
