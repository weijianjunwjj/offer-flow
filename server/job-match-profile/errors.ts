import type { ZodError } from 'zod';

export type JobMatchProfileErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_VERSION_CONFLICT'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_DECIDED'
  | 'DUPLICATE_PENDING_PROPOSAL'
  | 'INVALID_PROFILE_PROPOSAL'
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_STRUCTURED_OUTPUT_INVALID'
  | 'ACTIVE_VERSION_NOT_FOUND'
  | 'NO_EFFECTIVE_CHANGE'
  | 'IDEMPOTENCY_KEY_REUSED';

export class JobMatchProfileError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422 | 503,
    readonly code: JobMatchProfileErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'JobMatchProfileError';
  }

  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function invalidProposal(error: ZodError): JobMatchProfileError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return new JobMatchProfileError(422, 'INVALID_PROFILE_PROPOSAL', '岗位匹配画像提案校验失败', {
    fieldErrors,
  });
}
