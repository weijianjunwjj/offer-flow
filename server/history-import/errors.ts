import type { ZodError } from 'zod';

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  currentVersion?: number;
}

export class HistoryImportError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'HistoryImportError';
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

export function validationError(error: ZodError): HistoryImportError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new HistoryImportError(422, {
    code: 'VALIDATION_ERROR',
    message: '请求数据校验失败',
    fieldErrors,
  });
}

export function notFound(
  code:
    | 'SESSION_NOT_FOUND'
    | 'BASELINE_DRAFT_NOT_FOUND'
    | 'EVENT_DRAFT_NOT_FOUND',
  message: string,
): HistoryImportError {
  return new HistoryImportError(404, { code, message });
}

export function conflict(
  code:
    | 'VERSION_CONFLICT'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'SESSION_NOT_DRAFTABLE',
  message: string,
  details: Pick<ApiErrorBody, 'currentVersion'> = {},
): HistoryImportError {
  return new HistoryImportError(409, { code, message, ...details });
}

export function ruleViolation(
  code:
    | 'BUSINESS_RULE_VIOLATION'
    | 'SESSION_ALREADY_FINALIZED',
  message: string,
): HistoryImportError {
  return new HistoryImportError(422, { code, message });
}
