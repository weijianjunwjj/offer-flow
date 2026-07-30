/** 状态机的纯判断逻辑：给定当前状态和最新事件，决定下一阶段。不含 IO。 */
import type { StopReason } from './types';
import type { RunState } from './store';
import type { CcAutoConfig } from './config';
import { checkBudgetBeforeCall, summarizeUsage, opusShare } from './budget';

export interface EscalationInput {
  riskScore: number;
  touchesHighRisk: boolean;
  repeatedFingerprint: boolean;
  acceptanceConflict: boolean;
}

/** 是否需要升级到仲裁（Opus）。风险分与重复失败判定优先于模型自评。 */
export function shouldEscalateToArbiter(input: EscalationInput): boolean {
  if (input.riskScore >= 8) return true;
  if (input.repeatedFingerprint) return true;
  if (input.touchesHighRisk && input.riskScore >= 5) return true;
  if (input.acceptanceConflict) return true;
  return false;
}

/** 在发起下一次模型调用前做预算闭环检查；超限则返回停止原因，不发起调用。 */
export function budgetGate(
  state: RunState,
  config: CcAutoConfig,
  taskBudgetRmb: number,
  currentDailyRmb: number,
  estimatedNextCallRmb: number,
): { blocked: boolean; reason?: StopReason; detail?: string } {
  const totals = summarizeUsage(state.calls);
  const result = checkBudgetBeforeCall(
    taskBudgetRmb,
    config.budget.absoluteTaskMaxRmb,
    config.budget.dailyMaxRmb,
    totals.totalRmb,
    currentDailyRmb,
    estimatedNextCallRmb,
  );
  if (!result.exceeded) return { blocked: false };
  return { blocked: true, reason: result.reason, detail: result.detail };
}

export function opusShareExceeded(state: RunState, config: CcAutoConfig): boolean {
  const totals = summarizeUsage(state.calls);
  return opusShare(totals) > config.budget.opusShareMax && totals.byModel.arbiter > 0;
}

export function changedFilesExceeded(state: RunState, config: CcAutoConfig): boolean {
  return state.changedFiles.length > config.limits.maxChangedFiles;
}
