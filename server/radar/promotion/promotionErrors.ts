/**
 * V8-6 晋升领域错误：稳定语义码 + 安全文案（绝不回显 JD / Provider / 分析原文）。
 * HTTP 边界据 code 映射安全状态码（第二波接线）。
 */
export type PromotionErrorCode =
  | 'CANDIDATE_VERSION_NOT_FOUND'
  | 'CANDIDATE_VERSION_NOT_ACTIVE'
  | 'PROMOTION_TRIGGER_NOT_ALLOWED'
  | 'PROMOTION_TARGET_CONFLICT';

export class PromotionError extends Error {
  constructor(readonly code: PromotionErrorCode, message: string) {
    super(message);
    this.name = 'PromotionError';
  }
}

export function candidateVersionNotFound(): PromotionError {
  return new PromotionError('CANDIDATE_VERSION_NOT_FOUND', '候选版本不存在');
}

/** 只允许晋升候选的当前正式版本，避免用过期版本写正式事实（TD §11.7）。 */
export function candidateVersionNotActive(): PromotionError {
  return new PromotionError('CANDIDATE_VERSION_NOT_ACTIVE', '该候选版本不是当前正式版本，不能晋升');
}

/** no_response 不构成任何正式事实：连 job_only 都不允许（US-09 硬否定规则）。 */
export function triggerNotAllowed(): PromotionError {
  return new PromotionError('PROMOTION_TRIGGER_NOT_ALLOWED', '当前触发原因不足以晋升为正式记录');
}

/** 传入的既有正式对象彼此不一致（如 application 不属于该 job）。 */
export function targetConflict(message: string): PromotionError {
  return new PromotionError('PROMOTION_TARGET_CONFLICT', message);
}
