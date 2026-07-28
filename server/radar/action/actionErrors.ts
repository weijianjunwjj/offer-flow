/**
 * RC-10 雷达动作领域错误：稳定语义码 + 安全文案（绝不回显 JD / 分析原文）。
 * HTTP 边界据 code 映射安全状态码（后续波次接线）。
 */
export type RadarActionErrorCode =
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_HAS_NO_ACTIVE_VERSION';

export class RadarActionError extends Error {
  constructor(readonly code: RadarActionErrorCode, message: string) {
    super(message);
    this.name = 'RadarActionError';
  }
}

export function candidateNotFound(): RadarActionError {
  return new RadarActionError('CANDIDATE_NOT_FOUND', '候选不存在');
}

/** 动作必须绑定候选当前正式版本作为审计锚点（INV-04）；无 active 版本则拒绝写入。 */
export function candidateHasNoActiveVersion(): RadarActionError {
  return new RadarActionError('CANDIDATE_HAS_NO_ACTIVE_VERSION', '候选没有当前正式版本，不能记录动作');
}
