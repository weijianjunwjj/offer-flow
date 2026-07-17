import type { ZodError } from 'zod';

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  currentVersion?: number;
  existingId?: string;
}

export class JobMemoryError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'JobMemoryError';
  }
}

export class StorageCorruptionError extends Error {
  readonly storageCause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'StorageCorruptionError';
    this.storageCause = cause;
  }
}

export function validationError(error: ZodError): JobMemoryError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new JobMemoryError(422, {
    code: 'VALIDATION_ERROR',
    message: '请求数据校验失败',
    fieldErrors,
  });
}

export function notFound(
  code: 'JOB_NOT_FOUND' | 'APPLICATION_NOT_FOUND' | 'FEEDBACK_EVENT_NOT_FOUND' | 'RESUME_VERSION_NOT_FOUND',
  message: string,
): JobMemoryError {
  return new JobMemoryError(404, { code, message });
}

export function conflict(
  code:
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'CONTENT_HASH_EXISTS'
    | 'EVENT_ALREADY_VOIDED'
    | 'APPLICATION_ALREADY_VOIDED'
    | 'ACTIVE_RESUME_CONFLICT',
  message: string,
  details: Pick<ApiErrorBody, 'currentVersion' | 'existingId'> = {},
): JobMemoryError {
  return new JobMemoryError(409, { code, message, ...details });
}

export function ruleViolation(
  code:
    | 'BUSINESS_RULE_VIOLATION'
    | 'NO_EFFECTIVE_CHANGE'
    | 'ARCHIVED_RESUME_NOT_SELECTABLE'
    | 'AUDIT_EVENT_NOT_USER_CREATABLE'
    | 'INVALID_REPLACEMENT_EVENT',
  message: string,
): JobMemoryError {
  return new JobMemoryError(422, { code, message });
}
