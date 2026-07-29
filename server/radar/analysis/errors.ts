/**
 * V8-4 可靠单岗位分析 · 任务领域错误。
 *
 * 这是**领域层**错误（状态机 + Repository），与 API 层 RadarCaptureError 分离：
 * 本波次不注册路由，也不做 HTTP 映射，映射留给后续服务/路由波次。
 *
 * 安全边界（对齐设计 §12.3 / T-15）：错误 message 只允许出现稳定的领域语义，
 * **绝不**包含 inputSnapshot 全文、JD、Prompt、Token 或 Provider 原始响应。
 */
export const ANALYSIS_TASK_DOMAIN_ERROR_CODES = [
  'TASK_NOT_FOUND',
  'INVALID_TASK_TRANSITION',
  'TASK_ATTEMPTS_EXHAUSTED',
  'TASK_INPUT_CONFLICT',
  'TASK_RESULT_CONFLICT',
  'TASK_STATE_CONFLICT',
] as const;
export type AnalysisTaskDomainErrorCode = (typeof ANALYSIS_TASK_DOMAIN_ERROR_CODES)[number];

export class AnalysisTaskDomainError extends Error {
  constructor(
    readonly code: AnalysisTaskDomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisTaskDomainError';
  }
}

export function invalidTransition(from: string, attempted: string): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError(
    'INVALID_TASK_TRANSITION',
    `任务当前状态 ${from} 不允许执行 ${attempted}`,
  );
}

export function attemptsExhausted(attemptCount: number, maxAttempts: number): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError(
    'TASK_ATTEMPTS_EXHAUSTED',
    `任务执行次数已达上限（${attemptCount}/${maxAttempts}），不再排程`,
  );
}

export function inputConflict(): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError(
    'TASK_INPUT_CONFLICT',
    '相同任务 ID 对应了不同的 input hash 或 input snapshot，拒绝静默复用',
  );
}

export function resultConflict(): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError(
    'TASK_RESULT_CONFLICT',
    '任务已成功且关联了不同的结果记录，拒绝覆盖',
  );
}

export function stateConflict(message: string): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError('TASK_STATE_CONFLICT', message);
}

export function taskNotFound(): AnalysisTaskDomainError {
  return new AnalysisTaskDomainError('TASK_NOT_FOUND', '分析任务不存在');
}
