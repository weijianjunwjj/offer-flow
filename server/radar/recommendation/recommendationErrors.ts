/**
 * V8-5 推荐批次领域错误：稳定语义码 + 安全文案（绝不回显分析/JD/Provider 原文）。
 * HTTP 边界据 code 映射安全状态码。
 */
export type RecommendationErrorCode =
  | 'SCOPE_EMPTY'
  | 'SCOPE_TOO_LARGE'
  | 'CANDIDATE_VERSION_NOT_FOUND';

export class RecommendationError extends Error {
  constructor(readonly code: RecommendationErrorCode, message: string) {
    super(message);
    this.name = 'RecommendationError';
  }
}

export function emptyScope(): RecommendationError {
  return new RecommendationError('SCOPE_EMPTY', '推荐 scope 不能为空');
}

export function tooManyScopeItems(limit: number): RecommendationError {
  return new RecommendationError('SCOPE_TOO_LARGE', `推荐 scope 超过上限 ${limit}`);
}

export function candidateNotFound(): RecommendationError {
  return new RecommendationError('CANDIDATE_VERSION_NOT_FOUND', '候选版本不存在');
}
