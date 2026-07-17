import type { ZodError } from 'zod';

export type CapabilityBaselineErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'STATE_VERSION_CONFLICT'
  | 'EVIDENCE_NOT_FOUND'
  | 'EVIDENCE_ALREADY_DECIDED'
  | 'DUPLICATE_EVIDENCE'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_DECIDED'
  | 'DUPLICATE_PENDING_PROPOSAL'
  | 'BASELINE_EVIDENCE_REQUIRED'
  | 'INVALID_CAPABILITY_INPUT'
  | 'GUARDRAIL_VIOLATION'
  | 'EVIDENCE_REFERENCE_MISSING'
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_STRUCTURED_OUTPUT_INVALID'
  | 'ACTIVE_VERSION_NOT_FOUND'
  | 'NO_EFFECTIVE_CHANGE'
  | 'IDEMPOTENCY_KEY_REUSED';

export class CapabilityBaselineError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422 | 503,
    readonly code: CapabilityBaselineErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CapabilityBaselineError';
  }

  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function invalidCapabilityInput(error: ZodError): CapabilityBaselineError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return new CapabilityBaselineError(422, 'INVALID_CAPABILITY_INPUT', '能力基线输入校验失败', {
    fieldErrors,
  });
}
