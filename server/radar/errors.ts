import type { ZodError } from 'zod';

/** 雷达领域存储层损坏错误：JSON 列无法解析或缺失必需字段。 */
export class RadarStorageCorruptionError extends Error {
  readonly storageCause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RadarStorageCorruptionError';
    this.storageCause = cause;
  }
}

export function parseJsonColumn(column: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new RadarStorageCorruptionError(`存储列 ${column} 不是 JSON 字符串`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new RadarStorageCorruptionError(`存储列 ${column} 包含非法 JSON`, error);
  }
}

export interface RadarApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

/** V8-2 采集桥 API 错误：会话/条目校验、状态冲突、来源拒绝等。 */
export class RadarCaptureError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 422,
    readonly body: RadarApiErrorBody,
  ) {
    super(body.message);
    this.name = 'RadarCaptureError';
  }
}

export function radarValidationError(error: ZodError): RadarCaptureError {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return new RadarCaptureError(422, {
    code: 'VALIDATION_ERROR',
    message: '请求数据校验失败',
    fieldErrors,
  });
}

export function radarSessionNotFound(): RadarCaptureError {
  return new RadarCaptureError(404, { code: 'SESSION_NOT_FOUND', message: '采集会话不存在' });
}

export function radarSessionExpired(): RadarCaptureError {
  return new RadarCaptureError(409, { code: 'SESSION_EXPIRED', message: '采集会话已过期，请重新采集' });
}

export function radarSessionNotDraftable(): RadarCaptureError {
  return new RadarCaptureError(409, { code: 'SESSION_NOT_DRAFTABLE', message: '会话已提交或已取消，不能再修改' });
}

export function radarItemIndexNotFound(): RadarCaptureError {
  return new RadarCaptureError(404, { code: 'ITEM_NOT_FOUND', message: '预览条目不存在' });
}

export function radarTooManyItems(limit: number): RadarCaptureError {
  return new RadarCaptureError(422, {
    code: 'TOO_MANY_ITEMS',
    message: `单个采集会话最多支持 ${limit} 条预览条目`,
  });
}

export function radarForbiddenOrigin(): RadarCaptureError {
  return new RadarCaptureError(403, { code: 'ORIGIN_NOT_ALLOWED', message: '来源不允许访问本地采集接口' });
}

/**
 * 会话已提交，但再次提交时内容与首次提交不一致：拒绝。
 * 与「完全相同的重复提交幂等重放」区分开——只有内容不同才走这个冲突。
 */
export function radarCommitConflict(): RadarCaptureError {
  return new RadarCaptureError(409, {
    code: 'COMMIT_CONFLICT',
    message: '会话已提交，且本次提交内容与首次不一致，拒绝重复提交',
  });
}
