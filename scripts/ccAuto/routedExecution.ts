/** cc-auto v0.2.0 Slice R0 — Provider 级路由执行入口。
 *
 * 职责：
 * - 构建路由上下文 → 选择首个模型 → 生成预算 → 报告预算 → 执行 → 评估 → 升级
 * - 每次调用产生独立的 RoutingDecisionRecord + UsageRecord
 * - 最大升级链：Flash → Pro → Opus 裁决 → STOP
 *
 * 边界声明：
 * - 本模块执行 Provider 级模型路由：单次或有限升级的 Provider API 调用，
 *   配合预算估算与成本复盘。不执行编码工具循环（write_file/edit_file 等
 *   repository 工具），不完成 cc-auto 编码状态机。
 * - 本模块作为未接生产编码链的基础设施保留，供后续 1E-W 切片接入真正的
 *   DeepSeek Tool Loop。
 * - 正式 cc:auto run 当前仍走 Claude CLI 路径（orchestrator → runClaude）。
 * - 路由关闭时不自动选择/升级模型，但仍可通过 legacy 参数执行 Provider 调用。
 */

import type {
  ExecutionModelRole,
  ModelRoutingContext,
  ModelSelection,
  RoutedExecutionResult,
  RoutedExecutionStatus,
  ArbitrationCapsule,
  TaskBudgetEstimate,
  TaskCostSummary,
  ModelAttemptFailureCategory,
  ModelAttemptFailure,
  UsageRecord,
  ProviderProfile,
  RoutedExecutionReporter,
  RoutingDecisionRecord,
} from './types';
import type { ModelPricing } from './types';
import type { ModelRoutingConfig, TaskBudgetPolicy } from './types';
import { selectExecutionModel, escalateContext } from './modelRouting';
import { estimateTaskBudget, checkBudgetLimits } from './taskBudget';
import { buildTaskCostSummary } from './taskCostSummary';
import { executeProviderCall, newCallId } from './executor';
import { redactForDisk } from './redact';
import {
  saveBudgetEstimate,
  saveRoutingDecision,
  saveCostSummary,
  saveArbitrationCapsule,
} from './store';

// ============================================================================
// 路由执行选项
// ============================================================================

export interface RoutedExecutionOptions {
  routingContext: ModelRoutingContext;
  runId: string;
  taskId: string;
  cwd: string;
  routingConfigInput: ModelRoutingConfig;
  budgetPolicyInput: TaskBudgetPolicy;
  pricingByModelLogicalName: Record<string, ModelPricing>;
  profileById: Record<string, ProviderProfile>;
  hasOpusProvider: boolean;
  executionParams: {
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
    timeoutMs: number;
    adapterRegistry: import('./types').ProviderAdapterResolver;
    parentEnv: NodeJS.ProcessEnv;
    toolMode?: import('./types').ProviderToolMode;
    tools?: import('./types').ProviderToolDefinition[];
    maxToolLoopTurns?: number;
  };
  usesToolLoop: boolean;
  maxEscalations?: number;
  /** 旧行为兼容：路由关闭时使用的 fallback profileId + modelLogicalName */
  legacyProfileId?: string;
  legacyModelLogicalName?: string;
  /** 报告器——注入用于 CLI 可见输出 */
  reporter?: RoutedExecutionReporter;
}

// ============================================================================
// executeWithModelRouting
// ============================================================================

const DEFAULT_MAX_ESCALATIONS = 2;

export async function executeWithModelRouting(
  opts: RoutedExecutionOptions,
): Promise<RoutedExecutionResult> {
  const maxEscalations = opts.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;

  const selections: ModelSelection[] = [];
  const callIds: string[] = [];
  const allUsageRecords: Array<{
    usage: UsageRecord;
    role: ExecutionModelRole;
    provider: string;
    modelLogicalName: string;
    /** 真实 callId，用于升级成本精确归因 */
    callId: string;
  }> = [];
  const attempts: Array<{
    role: ExecutionModelRole;
    failure?: ModelAttemptFailure;
  }> = [];
  const routingDecisions: RoutingDecisionRecord[] = [];
  let context = { ...opts.routingContext };
  let escalationCount = 0;
  let finalRole: ExecutionModelRole = 'FAST_EXECUTOR';

  // --- 1. 首次模型选择 ---
  let selection = selectExecutionModel(context, opts.routingConfigInput);
  selections.push(selection);

  // --- 2. 路由关闭时，使用 legacy 参数执行，不做路由+升级 ---
  if (!opts.routingConfigInput.enabled) {
    const profileId = opts.legacyProfileId ?? selection.profileId;
    const modelLogicalName = opts.legacyModelLogicalName ?? selection.modelLogicalName;
    const profile = opts.profileById[profileId];
    if (!profile) {
      return { status: 'FAILED', finalRole: selection.role, selections, callIds };
    }

    const callId = newCallId();
    const execResult = await executeProviderCall({
      profile,
      logicalModelName: modelLogicalName,
      role: 'builder',
      systemPrompt: opts.executionParams.systemPrompt,
      userPrompt: opts.executionParams.userPrompt,
      maxOutputTokens: opts.executionParams.maxOutputTokens,
      timeoutMs: opts.executionParams.timeoutMs,
      adapterRegistry: opts.executionParams.adapterRegistry,
      parentEnv: opts.executionParams.parentEnv,
      cwd: opts.cwd,
      runId: opts.runId,
      callId,
      tools: opts.executionParams.tools,
      toolMode: opts.executionParams.toolMode,
    });
    callIds.push(callId);
    if (execResult.usageRecord) {
      allUsageRecords.push({
        usage: execResult.usageRecord,
        role: 'FAST_EXECUTOR', provider: profileId, modelLogicalName,
        callId,
      });
    }
    return {
      status: execResult.ok ? 'COMPLETED' : 'FAILED',
      finalRole: 'FAST_EXECUTOR',
      selections,
      callIds,
    };
  }

  // --- 3. 生成预算 ---
  const pricingByModel: Record<string, ModelPricing> = {};
  for (const [logicalName, pricing] of Object.entries(opts.pricingByModelLogicalName)) {
    pricingByModel[logicalName] = pricing;
  }

  const budgetEstimate = estimateTaskBudget({
    runId: opts.runId,
    taskId: opts.taskId,
    initialSelection: selection,
    taskType: context.taskType,
    affectedFileCount: context.affectedFileCount,
    usesToolLoop: opts.usesToolLoop,
    maxToolLoopTurns: opts.executionParams.maxToolLoopTurns ?? 8,
    maxToolCalls: 16,
    systemPromptChars: opts.executionParams.systemPrompt.length,
    userPromptChars: opts.executionParams.userPrompt.length,
    routingConfig: opts.routingConfigInput,
    budgetPolicy: opts.budgetPolicyInput,
    pricingByModel,
    hasOpusProvider: opts.hasOpusProvider,
  });

  // --- 3a. 持久化预算（在第一条 PendingCall 之前）---
  saveBudgetEstimate(opts.cwd, opts.runId, budgetEstimate);

  // --- 3b. 报告预算（await —— 必须先于 Provider 调用；失败则 Provider 0 次）---
  if (opts.reporter) {
    const formatted = formatBudgetForUser(budgetEstimate, context, opts.routingConfigInput, opts.hasOpusProvider);
    try {
      await opts.reporter.onBudgetEstimate(budgetEstimate, formatted);
    } catch {
      // Budget reporter 失败 → 用户未看到预算，不能继续消耗 Token
      // REPORTER_OUTPUT_FAILED_BEFORE_EXECUTION: Provider 0 次调用，PendingCall 0
      const zeroSummary = buildFinalSummary({
        runId: opts.runId, taskId: opts.taskId,
        estimate: budgetEstimate, usageRecords: [], selections, attempts,
        completed: false, strongModelPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongModelLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
      });
      saveCostSummary(opts.cwd, opts.runId, zeroSummary);
      return {
        status: 'FAILED',
        finalRole: selection.role,
        selections,
        callIds: [],
        reporterError: 'REPORTER_OUTPUT_FAILED_BEFORE_EXECUTION' as const,
      };
    }
  }

  // --- 3c. 检查预算限制 ---
  const budgetCheck = checkBudgetLimits(budgetEstimate, opts.budgetPolicyInput);
  if (!budgetCheck.ok) {
    const isHard = budgetCheck.reason === 'HARD_LIMIT';
    const status: RoutedExecutionStatus = isHard
      ? 'BUDGET_LIMIT_EXCEEDED'
      : 'BUDGET_CONFIRMATION_REQUIRED';

    // 仍然生成成本总结（0 次调用）
    const zeroSummary = buildFinalSummary({
      runId: opts.runId, taskId: opts.taskId,
      estimate: budgetEstimate, usageRecords: [], selections, attempts,
      completed: false, strongModelPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
      strongModelLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
    });
    saveCostSummary(opts.cwd, opts.runId, zeroSummary);
    if (opts.reporter) {
      const formatted = formatCostSummaryForUser(zeroSummary, opts.hasOpusProvider);
      await opts.reporter.onCostSummary(zeroSummary, formatted);
    }

    return { status, finalRole: selection.role, selections, callIds: [] };
  }

  // --- 4. 执行循环（含升级）---
  let routingDecisionCounter = 0;

  while (escalationCount <= maxEscalations) {
    // 持久化路由决策
    routingDecisionCounter++;
    // attemptId 用于关联 RoutingDecisionRecord → callId → UsageRecord
    const attemptId = `attempt-${opts.runId}-${escalationCount}`;
    // escalatedFromCallId 引用上一轮的真实 callId（非 modelLogicalName）
    const previousCallId = escalationCount > 0 ? callIds[callIds.length - 1] : undefined;
    const decision: RoutingDecisionRecord = {
      decisionId: `rd-${opts.runId}-${routingDecisionCounter}`,
      runId: opts.runId, taskId: opts.taskId,
      attemptId,
      role: selection.role,
      provider: selection.provider, profileId: selection.profileId,
      modelLogicalName: selection.modelLogicalName,
      source: selection.source,
      reasonCodes: [...selection.reasonCodes],
      policyVersion: 'cc-auto-model-routing-v1',
      escalatedFromCallId: previousCallId,
      createdAt: new Date().toISOString(),
    };
    routingDecisions.push(decision);
    saveRoutingDecision(opts.cwd, opts.runId, decision);

    finalRole = selection.role;

    // Opus 仲裁——首先生成 Capsule（不依赖 profile 存在）
    if (selection.role === 'ARBITER') {
      const capsule = buildArbitrationCapsule({
        taskGoal: opts.executionParams.userPrompt || opts.executionParams.systemPrompt,
        hardConstraints: [], context, selections, attempts,
        usageRecords: allUsageRecords,
      });
      saveArbitrationCapsule(opts.cwd, opts.runId, capsule);

      // 只有 hasOpusProvider=true 时才查找 Arbiter profile 并调用 Provider
      if (opts.hasOpusProvider) {
        const arbiterProfile = opts.profileById[selection.profileId];
        if (!arbiterProfile) {
          return await finalizeResult({
            status: 'FAILED', finalRole: 'ARBITER', selections, callIds,
            usageRecords: allUsageRecords, attempts,
            estimate: budgetEstimate,
            strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
            strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
            hasOpusProvider: true, routingDecisions, completed: false,
            cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
            reporter: opts.reporter,
            failureCategory: 'CREDENTIAL_FAILURE',
            capsule,
          });
        }

        try {
          const arbiterCallId = newCallId();
          const arbiterResult = await executeProviderCall({
            profile: arbiterProfile!,
            logicalModelName: selection.modelLogicalName,
            role: 'arbiter',
            systemPrompt: buildArbiterSystemPrompt(),
            userPrompt: JSON.stringify(capsule, null, 2),
            maxOutputTokens: opts.executionParams.maxOutputTokens,
            timeoutMs: opts.executionParams.timeoutMs,
            adapterRegistry: opts.executionParams.adapterRegistry,
            parentEnv: opts.executionParams.parentEnv,
            cwd: opts.cwd, runId: opts.runId, callId: arbiterCallId,
          });
          callIds.push(arbiterCallId);
          if (arbiterResult.ok && arbiterResult.usageRecord) {
            allUsageRecords.push({
              usage: arbiterResult.usageRecord,
              role: 'ARBITER', provider: selection.provider,
              modelLogicalName: selection.modelLogicalName,
              callId: arbiterCallId,
            });
          }
          return await finalizeResult({
            status: 'COMPLETED', finalRole: 'ARBITER', selections, callIds,
            usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
            strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
            strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
            hasOpusProvider: true, routingDecisions, completed: true,
            cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
            reporter: opts.reporter, capsule,
          });
        } catch {
          return await finalizeResult({
            status: 'OPUS_ARBITRATION_REQUIRED', finalRole: 'ARBITER', selections, callIds,
            usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
            strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
            strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
            hasOpusProvider: true, routingDecisions, completed: false,
            cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
            reporter: opts.reporter, capsule,
          });
        }
      }

      // hasOpusProvider=false：胶囊已生成并持久化，返回 OPUS_ARBITRATION_REQUIRED
      return await finalizeResult({
        status: 'OPUS_ARBITRATION_REQUIRED', finalRole: 'ARBITER', selections, callIds,
        usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
        strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
        hasOpusProvider: false, routingDecisions, completed: false,
        cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
        reporter: opts.reporter, capsule,
      });
    }

    // Flash / Pro 执行——必须存在对应的 profile
    const profile = opts.profileById[selection.profileId];
    if (!profile) {
      return await finalizeResult({
        status: 'FAILED', finalRole: selection.role, selections, callIds,
        usageRecords: allUsageRecords, attempts,
        estimate: budgetEstimate,
        strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
        hasOpusProvider: opts.hasOpusProvider,
        routingDecisions, completed: false,
        cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
        reporter: opts.reporter,
        failureCategory: 'CREDENTIAL_FAILURE',
      });
    }

    const callId = newCallId();
    const execResult = await executeProviderCall({
      profile,
      logicalModelName: selection.modelLogicalName,
      role: 'builder',
      systemPrompt: opts.executionParams.systemPrompt,
      userPrompt: opts.executionParams.userPrompt,
      maxOutputTokens: opts.executionParams.maxOutputTokens,
      timeoutMs: opts.executionParams.timeoutMs,
      adapterRegistry: opts.executionParams.adapterRegistry,
      parentEnv: opts.executionParams.parentEnv,
      cwd: opts.cwd, runId: opts.runId, callId,
      tools: opts.executionParams.tools,
      toolMode: opts.executionParams.toolMode,
    });
    callIds.push(callId);

    if (execResult.usageRecord) {
      allUsageRecords.push({
        usage: execResult.usageRecord,
        role: selection.role,
        provider: selection.provider,
        modelLogicalName: selection.modelLogicalName,
        callId,
      });
    }

    // 成功
    if (execResult.ok) {
      attempts.push({ role: selection.role });
      return await finalizeResult({
        status: 'COMPLETED', finalRole, selections, callIds,
        usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
        strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
        hasOpusProvider: opts.hasOpusProvider, routingDecisions, completed: true,
        cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
        reporter: opts.reporter,
      });
    }

    // 失败
    const failureCategory = mapStopReasonToFailureCategory(execResult.stopReason);
    const failure: ModelAttemptFailure = {
      category: failureCategory,
      summary: execResult.message,
      contributedToFinalResult: false,
    };
    attempts.push({ role: selection.role, failure });

    if (!context.allowEscalation) {
      return await finalizeResult({
        status: 'FAILED', finalRole: selection.role, selections, callIds,
        usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
        strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
        hasOpusProvider: opts.hasOpusProvider, routingDecisions, completed: false,
        cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
        reporter: opts.reporter, failureCategory,
      });
    }

    if (!shouldEscalate(failureCategory)) {
      return await finalizeResult({
        status: 'FAILED', finalRole: selection.role, selections, callIds,
        usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
        strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
        strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
        hasOpusProvider: opts.hasOpusProvider, routingDecisions, completed: false,
        cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
        reporter: opts.reporter, failureCategory,
      });
    }

    context = escalateContext(context, selection.role, failureCategory, execResult.message);
    escalationCount++;
    // 保存本次失败调用的 callId 到下一轮 selection.escalatedFromCallId（用于精确成本归因）
    const escalationCallId = callId;
    selection = selectExecutionModel(context, opts.routingConfigInput);
    selection.escalatedFromCallId = escalationCallId;
    selections.push(selection);

    if (selection.role === 'ARBITER') {
      continue;
    }
  }

  return await finalizeResult({
    status: 'FAILED', finalRole: selection.role, selections, callIds,
    usageRecords: allUsageRecords, attempts, estimate: budgetEstimate,
    strongPricing: pricingByModel[opts.routingConfigInput.strongModel.modelLogicalName] ?? null,
    strongLogicalName: opts.routingConfigInput.strongModel.modelLogicalName,
    hasOpusProvider: opts.hasOpusProvider, routingDecisions, completed: false,
    cwd: opts.cwd, runId: opts.runId, taskId: opts.taskId,
    reporter: opts.reporter,
    failureCategory: 'MODEL_QUALITY_FAILURE',
  });
}

// ============================================================================
// 汇总
// ============================================================================

async function finalizeResult(params: {
  status: RoutedExecutionStatus;
  finalRole: ExecutionModelRole;
  selections: ModelSelection[];
  callIds: string[];
  usageRecords: Array<{ usage: UsageRecord; role: ExecutionModelRole; provider: string; modelLogicalName: string }>;
  attempts: Array<{ role: ExecutionModelRole; failure?: ModelAttemptFailure }>;
  estimate: TaskBudgetEstimate;
  strongPricing: ModelPricing | null;
  strongLogicalName: string;
  hasOpusProvider: boolean;
  routingDecisions: RoutingDecisionRecord[];
  completed: boolean;
  cwd: string;
  runId: string;
  taskId: string;
  reporter?: RoutedExecutionReporter;
  capsule?: ArbitrationCapsule;
  failureCategory?: ModelAttemptFailureCategory;
}): Promise<RoutedExecutionResult> {
  const summary = buildFinalSummary({
    runId: params.runId, taskId: params.taskId,
    estimate: params.estimate,
    usageRecords: params.usageRecords,
    selections: params.selections,
    attempts: params.attempts,
    completed: params.completed,
    strongModelPricing: params.strongPricing,
    strongModelLogicalName: params.strongLogicalName,
  });
  saveCostSummary(params.cwd, params.runId, summary);

  // Report cost summary — must be awaited.
  // Reporter 失败不改变已完成调用记录，成本总结已持久化。
  // 但必须报告 REPORTER_OUTPUT_FAILED_AFTER_EXECUTION。
  let reporterFailed = false;
  if (params.reporter) {
    const formatted = formatCostSummaryForUser(summary, params.hasOpusProvider);
    try {
      const result = params.reporter.onCostSummary(summary, formatted);
      if (result instanceof Promise) {
        await result;
      }
    } catch {
      reporterFailed = true;
    }
  }

  return {
    status: params.status,
    finalRole: params.finalRole,
    selections: params.selections,
    callIds: params.callIds,
    arbitrationCapsule: params.capsule,
    failureCategory: params.failureCategory,
    ...(reporterFailed ? { reporterError: 'REPORTER_OUTPUT_FAILED_AFTER_EXECUTION' as const } : {}),
  };
}

function buildFinalSummary(params: Parameters<typeof buildTaskCostSummary>[0]): TaskCostSummary {
  return buildTaskCostSummary(params);
}

// ============================================================================
// 内部辅助
// ============================================================================

function mapStopReasonToFailureCategory(
  stopReason: string | null,
): ModelAttemptFailureCategory {
  switch (stopReason) {
    case 'PROVIDER_ERROR':
    case 'PROVIDER_TIMEOUT':
      return 'TRANSPORT_FAILURE';
    case 'PROVIDER_AUTH_ERROR':
      return 'CREDENTIAL_FAILURE';
    case 'MODEL_IDENTITY_MISMATCH':
      return 'MODEL_IDENTITY_FAILURE';
    case 'TRANSPORT_NOT_IMPLEMENTED':
      return 'TRANSPORT_FAILURE';
    case 'PRICING_NOT_FOUND':
    case 'COST_UNAVAILABLE':
      return 'BALANCE_FAILURE';
    default:
      return 'MODEL_QUALITY_FAILURE';
  }
}

function shouldEscalate(category: ModelAttemptFailureCategory): boolean {
  const NO_ESCALATE: Set<ModelAttemptFailureCategory> = new Set([
    'TRANSPORT_FAILURE', 'CREDENTIAL_FAILURE', 'BALANCE_FAILURE',
    'CONTEXT_LIMIT', 'LOCAL_TOOL_FAILURE', 'FILE_SCOPE_FAILURE',
    'USER_CANCELLED', 'MODEL_IDENTITY_FAILURE',
  ]);
  return !NO_ESCALATE.has(category);
}

function buildArbiterSystemPrompt(): string {
  return `你是一个架构裁决助手。你的唯一职责是：
1. 判断失败根因
2. 裁决冲突方案
3. 重新划定边界
4. 输出纠偏计划
5. 指定下一次应由 Flash 还是 Pro 执行
6. 明确禁止事项和验收标准

你不执行 Tool Loop，不直接修改文件，不运行测试，不做大范围仓库读取。
只返回结构化裁决结果。`;
}

function buildArbitrationCapsule(params: {
  taskGoal: string;
  hardConstraints: string[];
  context: ModelRoutingContext;
  selections: ModelSelection[];
  attempts: Array<{ role: ExecutionModelRole; failure?: ModelAttemptFailure }>;
  usageRecords: Array<{ role: ExecutionModelRole; modelLogicalName: string; usage: UsageRecord }>;
}): ArbitrationCapsule {
  const { context, selections, attempts } = params;
  const attemptedModels = attempts.map((a, i) => ({
    role: a.role,
    modelLogicalName: selections[i]?.modelLogicalName ?? 'unknown',
    outcome: a.failure ? `FAILED: ${a.failure.summary}` : 'SUCCESS',
    failureCategory: a.failure?.category ?? ('MODEL_QUALITY_FAILURE' as ModelAttemptFailureCategory),
  }));
  const changedFiles: string[] = [];
  const verifierFailures: string[] = attempts
    .filter((a) => a.failure?.category === 'VERIFIER_FAILURE')
    .map((a) => a.failure!.summary);
  const diffParts: string[] = [];
  for (const a of attempts) {
    if (a.failure) diffParts.push(a.failure.summary.slice(0, 500));
  }
  const relevantDiff = redactForDisk(diffParts.join('\n')).slice(0, 8000);
  const unresolvedQuestions: string[] = [];
  if (context.previousFailure && !context.specificationClear) {
    unresolvedQuestions.push('需求存在歧义，前序模型无法确定正确方案');
  }
  if (attempts.length >= 2) {
    unresolvedQuestions.push('多次尝试未通过验证，需确认根因与方案可行性');
  }
  return {
    taskGoal: params.taskGoal.slice(0, 2000),
    hardConstraints: params.hardConstraints,
    attemptedModels,
    changedFiles: changedFiles.slice(0, 20),
    verifierFailures: verifierFailures.slice(0, 10),
    relevantDiff,
    unresolvedQuestions: unresolvedQuestions.slice(0, 10),
  };
}

// ============================================================================
// 格式化（供 reporter 使用）
// ============================================================================

function formatBudgetForUser(
  estimate: TaskBudgetEstimate,
  _context: ModelRoutingContext,
  _config: ModelRoutingConfig,
  hasOpusProvider: boolean,
): string {
  const primary = estimate.estimatedCalls[0];
  const roleName = primary.role === 'FAST_EXECUTOR' ? 'V4 Flash' : primary.role === 'STRONG_EXECUTOR' ? 'V4 Pro' : 'Opus 5';
  const reasons = estimate.initialSelection.reasonCodes;
  const reasonText = reasons.includes('USER_FAST_OVERRIDE_REJECTED')
    ? `用户请求 Flash，但该任务涉及 ${reasons.filter((r) => r !== 'USER_FAST_OVERRIDE_REJECTED').slice(0, 3).join('、')}，已按质量底线使用 Pro。`
    : reasons.includes('USER_OVERRIDE')
      ? '用户指定'
      : reasons.join('、');

  const lines = [
    `任务预算`,
    ``,
    `首选模型：${roleName}`,
    `选择原因：${reasonText}`,
    ``,
  ];

  const exp = estimate.totalEstimatedCostRmb;
  if (exp.expected !== null) {
    lines.push(`常规预计：¥${exp.expected.toFixed(4)}`);
    const minText = exp.min !== null ? `¥${exp.min.toFixed(4)}` : (estimate.maxNullReason ? `无法计算：${estimate.maxNullReason}` : '未知');
    const maxText = exp.max !== null ? `¥${exp.max.toFixed(4)}` : (estimate.maxNullReason ? `无法计算：${estimate.maxNullReason}` : '未知');
    lines.push(`合理区间：${minText}～${maxText}`);
  } else {
    const reason = estimate.maxNullReason ?? '主模型缺少 pricing';
    lines.push(`常规预计：无法计算——${reason}`);
  }

  // 调用分布
  for (const c of estimate.estimatedCalls) {
    const name = c.role === 'FAST_EXECUTOR' ? 'V4 Flash' : c.role === 'STRONG_EXECUTOR' ? 'V4 Pro' : 'Opus 5';
    if (c.minCalls === 0 && c.expectedCalls === 0 && c.maxCalls === 1) {
      lines.push(`${name}：正常 0 次，升级时最多 1 次`);
    } else if (c.maxCalls > 0) {
      lines.push(`${name}：${c.minCalls}～${c.maxCalls} 次`);
    }
  }

  if (!hasOpusProvider) {
    lines.push(`Opus 当前不会自动调用，只会生成裁决 Capsule`);
  }

  for (const a of estimate.assumptions) {
    lines.push(`注意：${a}`);
  }

  return lines.join('\n');
}

function formatCostSummaryForUser(
  summary: TaskCostSummary,
  hasOpusProvider: boolean,
): string {
  const lines = [
    `模型成本复盘`,
    ``,
    `任务结果：${summary.completed ? '完成' : '失败 / 需要裁决'}`,
    ``,
  ];

  const exp = summary.estimate.totalEstimatedCostRmb;
  const estMaxReason = summary.estimate.maxNullReason;
  lines.push(`任务前常规预计：${exp.expected !== null ? `¥${exp.expected.toFixed(4)}` : (estMaxReason ? `无法计算——${estMaxReason}` : '无法计算')}`);
  lines.push(`任务前最坏上限：${exp.max !== null ? `¥${exp.max.toFixed(4)}` : (estMaxReason ? `无法计算——${estMaxReason}` : '无法计算')}`);
  lines.push(`实际成本：${formatRmb(summary.actual.costRmb)}`);
  lines.push(``);

  const cmp = summary.estimateComparison;
  lines.push(`实际 / 常规预计：${fmtPct(cmp.actualVsExpectedRatio)}`);
  lines.push(`实际 / 最坏上限：${fmtPct(cmp.actualVsMaximumRatio)}`);
  lines.push(``);

  // 按角色
  for (const entry of summary.byRole) {
    const roleName = entry.role === 'FAST_EXECUTOR' ? 'V4 Flash' : entry.role === 'STRONG_EXECUTOR' ? 'V4 Pro' : 'Opus 5';
    lines.push(`${roleName}：`);
    lines.push(`  调用次数：${entry.calls}`);
    lines.push(`  输入 Token：${entry.inputTokens ?? 'N/A'}`);
    lines.push(`  输出 Token：${entry.outputTokens ?? 'N/A'}`);
    lines.push(`  缓存 Token：${entry.cachedTokens ?? 'N/A'}`);
    lines.push(`  成本：${formatRmb(entry.costRmb)}`);
    lines.push(`  成本占比：${fmtPct(entry.costShare)}`);
    lines.push(``);
  }

  // Opus 现状
  const opusEntry = summary.byRole.find((e) => e.role === 'ARBITER');
  if (!opusEntry && !hasOpusProvider) {
    lines.push(`Opus 5：0 次自动调用，未纳入自动成本`);
  }

  // 升级
  const re = summary.routingEffect;
  lines.push(`升级次数：${re.escalationCount}`);
  if (re.escalationCostRmb !== null && re.escalationCostRmb > 0) {
    lines.push(`无贡献失败调用成本：¥${re.escalationCostRmb.toFixed(4)}`);
  }

  // 节省
  if (re.hypotheticalAllProCostRmb !== null) {
    lines.push(``);
    lines.push(`同 Token 全程 V4 Pro 基准：¥${re.hypotheticalAllProCostRmb.toFixed(4)}`);
    lines.push(`实际节省：${formatRmb(re.savedVsAllProRmb)}`);
    lines.push(`节省比例：${fmtPct(re.savedVsAllProPercent)}`);
  }

  return lines.join('\n');
}

function formatRmb(v: number | null): string {
  if (v === null) return '无法计算';
  return `¥${v.toFixed(4)}`;
}

function fmtPct(v: number | null): string {
  if (v === null) return 'N/A';
  return `${v.toFixed(1)}%`;
}
