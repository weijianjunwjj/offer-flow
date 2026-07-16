import type { ZodError } from 'zod';

export type MarketPositionErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'STATE_VERSION_CONFLICT'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_DECIDED'
  | 'DUPLICATE_PENDING_PROPOSAL'
  | 'INVALID_MARKET_POSITION_INPUT'
  | 'ACTIVE_VERSION_NOT_FOUND'
  | 'NO_EFFECTIVE_CHANGE'
  | 'IDEMPOTENCY_KEY_REUSED';

export class MarketPositionError extends Error {
  constructor(
    readonly statusCode: 404 | 409 | 422,
    readonly code: MarketPositionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MarketPositionError';
  }

  toBody(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function invalidMarketPositionInput(error: ZodError): MarketPositionError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return new MarketPositionError(422, 'INVALID_MARKET_POSITION_INPUT', '市场位置画像输入校验失败', {
    fieldErrors,
  });
}
