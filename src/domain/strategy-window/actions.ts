import {
  type StrategyAction,
  type StrategyAllocationPlan,
  type StrategyExperiment,
  type StrategyProposalDraft,
  type StrategyWindow,
} from './types';

export type StrategyValidationCode =
  | 'action_blocked'
  | 'allocation_invalid'
  | 'evidence_reference_invalid'
  | 'irreversible_action'
  | 'ab_multi_variable'
  | 'invalid_action';

export interface StrategyValidationError {
  code: StrategyValidationCode;
  message: string;
}

export interface StrategyValidationContext {
  window: StrategyWindow;
  acceptedEvidenceIds: readonly string[];
}

const ALLOCATION_EPSILON = 0.001;

function validateAction(
  action: StrategyAction,
  context: StrategyValidationContext,
): StrategyValidationError | null {
  const { window } = context;
  if (window.blockedActionTypes.includes(action.actionType)) {
    return { code: 'action_blocked', message: `动作「${action.actionType}」在当前策略窗口内被禁止` };
  }
  const permitted = window.allowedActionTypes.includes(action.actionType)
    || window.observeOnlyActionTypes.includes(action.actionType);
  if (!permitted) {
    return { code: 'action_blocked', message: `动作「${action.actionType}」不在当前策略窗口允许范围内` };
  }
  if (!Number.isFinite(action.targetCount) || action.targetCount < 0 || !Number.isInteger(action.targetCount)) {
    return { code: 'invalid_action', message: `动作「${action.title}」的目标数量必须是不小于 0 的整数` };
  }
  if (!Number.isFinite(action.allocationShare) || action.allocationShare < 0 || action.allocationShare > 100) {
    return { code: 'allocation_invalid', message: `动作「${action.title}」的分配比例必须在 0 到 100 之间` };
  }
  if (window.evidenceLevel !== 'supported' && !action.reversible) {
    return {
      code: 'irreversible_action',
      message: `证据等级为「${window.evidenceLevel}」时，所有策略行动都必须可逆，动作「${action.title}」不满足`,
    };
  }
  const invalidEvidenceId = action.sourceEvidenceIds.find((id) => !context.acceptedEvidenceIds.includes(id));
  if (invalidEvidenceId !== undefined) {
    return {
      code: 'evidence_reference_invalid',
      message: `动作「${action.title}」引用了不存在或未被接受的证据 ID：${invalidEvidenceId}`,
    };
  }
  return null;
}

function validateAllocationPlan(
  plan: StrategyAllocationPlan,
  window: StrategyWindow,
): StrategyValidationError | null {
  if (plan.entries.length === 0) return null;
  for (const entry of plan.entries) {
    if (!Number.isFinite(entry.share) || entry.share < 0 || entry.share > 100) {
      return { code: 'allocation_invalid', message: `分配维度「${plan.dimension}」的比例必须在 0 到 100 之间` };
    }
    if (window.evidenceLevel === 'insufficient' && !entry.exploratory) {
      return {
        code: 'allocation_invalid',
        message: `证据不足时，分配维度「${plan.dimension}」的样本只能标注为探索性，不得表述为优先级结论`,
      };
    }
  }
  const total = plan.entries.reduce((sum, entry) => sum + entry.share, 0);
  if (Math.abs(total - 100) > ALLOCATION_EPSILON) {
    return { code: 'allocation_invalid', message: `分配维度「${plan.dimension}」的比例总和必须为 100，当前为 ${total}` };
  }
  return null;
}

/** 单变量检测：变体不得相同，且不得在单个实验里用分隔符堆叠多个变量改动。 */
const MULTI_VARIABLE_MARKERS = ['+', '＋', '、', '，', ',', '&', ';', '；', ' 和 ', ' 与 '];

function validateExperiment(experiment: StrategyExperiment): StrategyValidationError | null {
  if (experiment.variable.trim() === '') {
    return { code: 'ab_multi_variable', message: `实验「${experiment.title}」必须明确单一变量` };
  }
  if (experiment.variantA.trim() === experiment.variantB.trim()) {
    return { code: 'ab_multi_variable', message: `实验「${experiment.title}」的 A/B 版本必须不同` };
  }
  if (MULTI_VARIABLE_MARKERS.some((marker) => experiment.variable.includes(marker))) {
    return { code: 'ab_multi_variable', message: `实验「${experiment.title}」不得同时改变多个核心变量` };
  }
  if (!experiment.reversible) {
    return { code: 'irreversible_action', message: `实验「${experiment.title}」必须可逆` };
  }
  if (!Number.isFinite(experiment.sampleTarget) || experiment.sampleTarget <= 0) {
    return { code: 'invalid_action', message: `实验「${experiment.title}」必须设定正的样本目标` };
  }
  return null;
}

/**
 * 对整份策略草稿执行确定性门禁校验：禁止动作、分配比例、证据引用、可逆性、单变量实验。
 * 手工提案与 AI 生成提案都必须通过这里；用户不能通过编辑绕过门禁。
 * 返回全部错误（空数组表示通过）。
 */
export function validateStrategyDraft(
  draft: StrategyProposalDraft,
  context: StrategyValidationContext,
): StrategyValidationError[] {
  const errors: StrategyValidationError[] = [];
  for (const action of draft.actions) {
    const error = validateAction(action, context);
    if (error !== null) errors.push(error);
  }
  for (const plan of draft.allocationPlans) {
    const error = validateAllocationPlan(plan, context.window);
    if (error !== null) errors.push(error);
  }
  for (const experiment of draft.experiments) {
    const error = validateExperiment(experiment);
    if (error !== null) errors.push(error);
  }
  return errors;
}
