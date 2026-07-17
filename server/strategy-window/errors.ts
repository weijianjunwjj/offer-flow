import type { ZodError } from 'zod';

export type StrategyErrorCode =
  | 'INVALID_STRATEGY_INPUT'
  | 'STRATEGY_INPUT_NOT_READY'
  | 'STRATEGY_WINDOW_EXPIRED'
  | 'STRATEGY_INPUT_STALE'
  | 'STRATEGY_ACTION_BLOCKED'
  | 'STRATEGY_ALLOCATION_INVALID'
  | 'STRATEGY_EVIDENCE_REFERENCE_INVALID'
  | 'STRATEGY_AI_UNAVAILABLE'
  | 'STRATEGY_AI_OUTPUT_INVALID'
  | 'STRATEGY_PROPOSAL_ALREADY_EXISTS'
  | 'STRATEGY_PROPOSAL_ALREADY_DECIDED'
  | 'STRATEGY_PROPOSAL_NOT_FOUND'
  | 'STRATEGY_ACTIVE_VERSION_NOT_FOUND'
  | 'STRATEGY_STATE_VERSION_CONFLICT'
  | 'STRATEGY_NO_EFFECTIVE_CHANGE'
  | 'STRATEGY_IDEMPOTENCY_KEY_REUSED';

export class StrategyError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422 | 503,
    readonly code: StrategyErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'StrategyError';
  }

  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function invalidStrategyInput(error: ZodError): StrategyError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return new StrategyError(422, 'INVALID_STRATEGY_INPUT', '求职策略输入校验失败', { fieldErrors });
}
