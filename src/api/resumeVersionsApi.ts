import { z } from 'zod';
import {
  ActiveResumeVersionResultSchema,
  ResumeVersionListResponseSchema,
  ResumeVersionRecordSchema,
  type ActiveResumeVersionResult,
  type ResumeVersionListResponse,
  type ResumeVersionRecord,
} from '../domain/job-memory';
import type {
  ActivateResumeVersionRequest,
  ArchiveResumeVersionRequest,
  CreateResumeVersionRequest,
  UpdateResumeVersionMetadataRequest,
} from '../../server/job-memory/dtoSchemas';
import { ApiError, apiGet, apiSend, type ReadOptions } from './client';

const JobMemoryApiErrorBodySchema = z.object({
  code: z.string().trim().min(1),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  currentVersion: z.number().int().positive().optional(),
  existingId: z.string().trim().min(1).optional(),
});

export type ResumeVersionApiErrorCode =
  | 'VERSION_CONFLICT'
  | 'CONTENT_HASH_EXISTS'
  | 'NO_EFFECTIVE_CHANGE'
  | 'RESUME_VERSION_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'ARCHIVED_RESUME_NOT_SELECTABLE'
  | 'ACTIVE_RESUME_CONFLICT'
  | 'BUSINESS_RULE_VIOLATION'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INTERNAL_ERROR'
  | 'FEATURE_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR';

export class ResumeVersionApiError extends Error {
  constructor(
    readonly code: ResumeVersionApiErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly fieldErrors?: Record<string, string[]>,
    readonly currentVersion?: number,
    readonly existingId?: string,
  ) {
    super(message);
    this.name = 'ResumeVersionApiError';
  }
}

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ResumeVersionApiError('INVALID_RESPONSE', '服务端返回了无法识别的数据');
  }
  return result.data;
}

function normalizeError(error: unknown): never {
  if (error instanceof ResumeVersionApiError) throw error;
  if (error instanceof DOMException && error.name === 'AbortError') throw error;
  if (error instanceof ApiError) {
    const parsed = JobMemoryApiErrorBodySchema.safeParse(error.body);
    if (parsed.success) {
      const body = parsed.data;
      const code = body.code === 'INTERNAL_ERROR'
        ? 'INTERNAL_ERROR'
        : body.code as ResumeVersionApiErrorCode;
      throw new ResumeVersionApiError(
        code,
        code === 'INTERNAL_ERROR' ? '简历版本存储暂时不可用' : body.message,
        error.status,
        body.fieldErrors,
        body.currentVersion,
        body.existingId,
      );
    }
    if (error.status === 404) {
      throw new ResumeVersionApiError(
        'FEATURE_UNAVAILABLE',
        '简历版本功能尚未在后端启用',
        error.status,
      );
    }
    if (error.status >= 500) {
      throw new ResumeVersionApiError('INTERNAL_ERROR', '简历版本存储暂时不可用', error.status);
    }
    throw new ResumeVersionApiError('HTTP_ERROR', `简历版本请求失败（${error.status}）`, error.status);
  }
  throw new ResumeVersionApiError('NETWORK_ERROR', '无法连接简历版本服务，请检查联调服务是否启动');
}

async function request<T>(operation: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T> {
  try {
    return parseResponse(schema, await operation());
  } catch (error) {
    normalizeError(error);
  }
}

export const resumeVersionsApi = {
  list(options?: ReadOptions): Promise<ResumeVersionListResponse> {
    return request(() => apiGet<unknown>('/resume-versions', options), ResumeVersionListResponseSchema);
  },
  create(input: CreateResumeVersionRequest): Promise<ResumeVersionRecord> {
    return request(
      () => apiSend<unknown>('/resume-versions', 'POST', input),
      ResumeVersionRecordSchema,
    );
  },
  updateMetadata(id: string, input: UpdateResumeVersionMetadataRequest): Promise<ResumeVersionRecord> {
    return request(
      () => apiSend<unknown>(`/resume-versions/${encodeURIComponent(id)}`, 'PATCH', input),
      ResumeVersionRecordSchema,
    );
  },
  activate(id: string, input: ActivateResumeVersionRequest): Promise<ActiveResumeVersionResult> {
    return request(
      () => apiSend<unknown>(`/resume-versions/${encodeURIComponent(id)}/activate`, 'POST', input),
      ActiveResumeVersionResultSchema,
    );
  },
  archive(id: string, input: ArchiveResumeVersionRequest): Promise<ActiveResumeVersionResult> {
    return request(
      () => apiSend<unknown>(`/resume-versions/${encodeURIComponent(id)}/archive`, 'POST', input),
      ActiveResumeVersionResultSchema,
    );
  },
};
