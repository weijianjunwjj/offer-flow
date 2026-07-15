import { z } from 'zod';

export interface FunnelErrorBody {
  code: string;
  message: string;
}

export class FunnelError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly body: FunnelErrorBody,
  ) {
    super(body.message);
  }
}

export function validationError(error: z.ZodError): FunnelError {
  return new FunnelError(422, {
    code: 'VALIDATION_ERROR',
    message: `请求参数校验失败：${error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`,
  });
}
