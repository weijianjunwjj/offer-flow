/** cc-auto v0.2.0 Slice 1F — 确定性模型路由策略。
 *
 * 职责：
 * - 纯函数 selectExecutionModel：基于结构化上下文选择模型
 * - 优先级固定：用户覆盖 > 路由关闭 > Opus 裁决 > Pro 高风险 > Flash 默认
 * - 不调用 LLM，不根据 Prompt 字数推测复杂度
 * - 不访问网络、凭证或文件系统
 * - 同一输入 → 同一输出（确定性，可测试）
 */

import type {
  ExecutionModelRole,
  ModelRoutingContext,
  ModelSelection,
  ModelRoutingReasonCode,
  ModelSelectionSource,
  ModelAttemptFailureCategory,
} from './types';
import type { ModelRoutingConfig } from './types';

// ============================================================================
// 决策优先级
// ============================================================================

/**
 * selectExecutionModel —— 纯函数，确定性选择模型。
 *
 * 优先级：
 * 1. 用户显式 STRONG_EXECUTOR / ARBITER → 允许向上覆盖
 * 2. 用户显式 FAST_EXECUTOR 但命中硬风险 → 拒绝，选择 STRONG_EXECUTOR
 * 3. 路由功能关闭 → FAST_EXECUTOR（旧行为兼容）
 * 4. Opus 裁决条件 (previousFailure + Pro 已失败)
 * 5. Pro 高风险条件
 * 6. Flash 默认路径
 */
export function selectExecutionModel(
  context: ModelRoutingContext,
  config: ModelRoutingConfig,
): ModelSelection {
  // --- 0. 用户请求 FAST_EXECUTOR，但命中硬风险 → 拒绝并返回 STRONG_EXECUTOR ---
  if (context.requestedRole === 'FAST_EXECUTOR') {
    const hardRisks = hardRiskReasons(context);
    if (hardRisks.length > 0 && config.enabled) {
      return buildSelection(
        'STRONG_EXECUTOR',
        config,
        'POLICY',
        ['USER_FAST_OVERRIDE_REJECTED', ...hardRisks],
      );
    }
    // 无硬风险 → 允许 Flash
    return buildSelection('FAST_EXECUTOR', config, 'USER_OVERRIDE', ['USER_OVERRIDE']);
  }

  // --- 1. 用户显式覆盖 (STRONG_EXECUTOR / ARBITER) — 始终允许向上 ---
  if (context.requestedRole) {
    return buildSelection(
      context.requestedRole,
      config,
      'USER_OVERRIDE',
      ['USER_OVERRIDE'],
    );
  }

  // --- 2. 路由功能关闭 → 旧行为兼容 ---
  if (!config.enabled) {
    return buildSelection(
      'FAST_EXECUTOR',
      config,
      'POLICY',
      ['DEFAULT_FLASH'],
    );
  }

  // --- 3. Opus 裁决条件：Pro 已失败 → ARBITER ---
  if (
    config.allowArbiterEscalation &&
    context.previousAttemptCount >= 1 &&
    context.previousModelRole === 'STRONG_EXECUTOR' &&
    context.previousFailure &&
    shouldEscalateToArbiter(context.previousFailure.category)
  ) {
    return buildSelection(
      'ARBITER',
      config,
      'ESCALATION',
      ['PRO_QUALITY_FAILURE', 'OPUS_ARBITRATION'],
    );
  }

  // --- 4. Pro 高风险条件 ---
  const proReasons = proRiskReasons(context);
  if (proReasons.length > 0) {
    return buildSelection('STRONG_EXECUTOR', config, 'POLICY', proReasons);
  }

  // --- 5. Flash 默认 ---
  return buildSelection('FAST_EXECUTOR', config, 'POLICY', ['DEFAULT_FLASH']);
}

// ============================================================================
// 升级判断：哪些失败类别允许升级
// ============================================================================

/** 允许升级到更贵模型的失败类别白名单 */
const UPGRADE_ELIGIBLE_FAILURES: Set<ModelAttemptFailureCategory> = new Set([
  'MODEL_QUALITY_FAILURE',
  'MODEL_PROTOCOL_FAILURE',
  'VERIFIER_FAILURE',
  'UNKNOWN',
]);

/** 传输/凭证/本地类错误不应该升级模型（换模型也无法解决） */
const TRANSPORT_FAILURES: Set<ModelAttemptFailureCategory> = new Set([
  'TRANSPORT_FAILURE',
  'CREDENTIAL_FAILURE',
  'BALANCE_FAILURE',
  'CONTEXT_LIMIT',
  'LOCAL_TOOL_FAILURE',
  'FILE_SCOPE_FAILURE',
  'USER_CANCELLED',
  'MODEL_IDENTITY_FAILURE',
]);

/**
 * Flash 失败后是否应该升级到 Pro。
 * 只有质量/协议/Verifier 类错误才升级；传输/凭证/本地错误不升级。
 */
export function shouldEscalateFlashToPro(
  failureCategory: ModelAttemptFailureCategory,
  allowEscalation: boolean,
): boolean {
  if (!allowEscalation) return false;
  if (TRANSPORT_FAILURES.has(failureCategory)) return false;
  return UPGRADE_ELIGIBLE_FAILURES.has(failureCategory);
}

/**
 * Pro 失败后是否应该进入 Opus 裁决。
 */
export function shouldEscalateToArbiter(
  failureCategory: ModelAttemptFailureCategory,
): boolean {
  return UPGRADE_ELIGIBLE_FAILURES.has(failureCategory);
}

// ============================================================================
// 内部辅助
// ============================================================================

function buildSelection(
  role: ExecutionModelRole,
  config: ModelRoutingConfig,
  source: ModelSelectionSource,
  reasonCodes: ModelRoutingReasonCode[],
): ModelSelection {
  const model = roleToConfigModel(role, config);
  return {
    role,
    provider: model.provider,
    profileId: model.profileId,
    modelLogicalName: model.modelLogicalName,
    source,
    reasonCodes,
    policyVersion: 'cc-auto-model-routing-v1',
  };
}

function roleToConfigModel(
  role: ExecutionModelRole,
  config: ModelRoutingConfig,
): { provider: string; profileId: string; modelLogicalName: string } {
  switch (role) {
    case 'FAST_EXECUTOR':
      return config.fastModel;
    case 'STRONG_EXECUTOR':
      return config.strongModel;
    case 'ARBITER':
      return config.arbiterModel ?? {
        provider: 'anthropic',
        profileId: 'opus-5',
        modelLogicalName: 'opus-5',
      };
  }
}

/**
 * 检测是否需要 Pro。原因码顺序稳定。
 */
function proRiskReasons(context: ModelRoutingContext): ModelRoutingReasonCode[] {
  const reasons: ModelRoutingReasonCode[] = [];

  if (context.touchesArchitecture) reasons.push('ARCHITECTURE_TASK');
  if (context.touchesSecurityBoundary) reasons.push('SECURITY_BOUNDARY');
  if (context.touchesProviderLifecycle) reasons.push('PROVIDER_LIFECYCLE');
  if (context.touchesPendingCallOrUsage) reasons.push('PENDING_CALL_OR_USAGE');
  if (context.touchesDatabaseSchema) reasons.push('DATABASE_SCHEMA');
  if (context.touchesTransactionOrConcurrency) reasons.push('TRANSACTION_OR_CONCURRENCY');
  if (context.touchesStateMachine) reasons.push('STATE_MACHINE');
  if (context.affectedFileCount >= 3) reasons.push('MULTI_FILE_CHANGE');
  if (!context.specificationClear) reasons.push('AMBIGUOUS_SPEC');
  if (context.taskType === 'ARCHITECTURE') reasons.push('ARCHITECTURE_TASK');
  if (context.taskType === 'FINAL_REVIEW') reasons.push('FINAL_REVIEW');

  return reasons;
}

/**
 * 硬风险检测：即使用户请求 FAST_EXECUTOR 也不能降级的条件。
 * 这些是"质量底线不可降低"的核心场景。
 */
function hardRiskReasons(context: ModelRoutingContext): ModelRoutingReasonCode[] {
  const reasons: ModelRoutingReasonCode[] = [];

  if (context.touchesArchitecture) reasons.push('ARCHITECTURE_TASK');
  if (context.touchesSecurityBoundary) reasons.push('SECURITY_BOUNDARY');
  if (context.touchesProviderLifecycle) reasons.push('PROVIDER_LIFECYCLE');
  if (context.touchesPendingCallOrUsage) reasons.push('PENDING_CALL_OR_USAGE');
  if (context.touchesDatabaseSchema) reasons.push('DATABASE_SCHEMA');
  if (context.touchesTransactionOrConcurrency) reasons.push('TRANSACTION_OR_CONCURRENCY');
  if (context.touchesStateMachine) reasons.push('STATE_MACHINE');
  if (context.affectedFileCount >= 3) reasons.push('MULTI_FILE_CHANGE');
  if (!context.specificationClear) reasons.push('AMBIGUOUS_SPEC');
  if (context.taskType === 'FINAL_REVIEW') reasons.push('FINAL_REVIEW');

  return reasons;
}

// ============================================================================
// 升级后上下文构造
// ============================================================================

/** 为升级后的重试构造新上下文（递增 attempt、标记 previous failure） */
export function escalateContext(
  context: ModelRoutingContext,
  previousRole: ExecutionModelRole,
  failureCategory: ModelAttemptFailureCategory,
  failureSummary: string,
): ModelRoutingContext {
  return {
    ...context,
    previousAttemptCount: context.previousAttemptCount + 1,
    previousModelRole: previousRole,
    previousFailure: {
      category: failureCategory,
      summary: failureSummary,
      contributedToFinalResult: false,
    },
  };
}

/** 标记最后一次失败为有贡献结果（不计入升级浪费） */
export function markFailureContributed(
  context: ModelRoutingContext,
): ModelRoutingContext {
  if (!context.previousFailure) return context;
  return {
    ...context,
    previousFailure: {
      ...context.previousFailure,
      contributedToFinalResult: true,
    },
  };
}
