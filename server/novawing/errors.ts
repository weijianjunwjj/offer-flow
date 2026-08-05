export const NOVA_WING_RUNTIME_ERROR_CODES = [
  'NOVA_WING_RUNTIME_INITIALIZATION_FAILED',
  'NOVA_WING_RUNTIME_APPLY_NOT_CONFIRMED',
] as const;

export type NovaWingRuntimeErrorCode = (typeof NOVA_WING_RUNTIME_ERROR_CODES)[number];

/** Stable infrastructure error that never retains the SQLite error or database path. */
export class NovaWingRuntimeError extends Error {
  constructor(readonly code: NovaWingRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'NovaWingRuntimeError';
  }
}

export function runtimeInitializationFailed(): NovaWingRuntimeError {
  return new NovaWingRuntimeError(
    'NOVA_WING_RUNTIME_INITIALIZATION_FAILED',
    'NovaWing runtime 初始化失败',
  );
}

export function developmentApplyNotConfirmed(): NovaWingRuntimeError {
  return new NovaWingRuntimeError(
    'NOVA_WING_RUNTIME_APPLY_NOT_CONFIRMED',
    'NovaWing schema apply 仅允许显式测试或开发初始化',
  );
}
