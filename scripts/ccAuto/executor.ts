/** cc-auto v0.2.0 Slice 1B — Provider 执行服务。
 *
 * 职责：
 * - 根据 ProviderProfile 选择 Adapter
 * - 构建隔离运行环境（buildChildEnv）
 * - 创建 PendingCall=PREPARED
 * - mock transport 接收标准化请求 → PendingCall=DISPATCHED
 * - 模型身份判定 → 费用计算 → UsageRecord 生成
 * - 原子写入 calls[] → 清除 PendingCall
 * - 输出明确的 ProviderExecutionResult
 *
 * 安全边界：
 * - 不使用 throw 作为正常领域分支
 * - 不输出密钥正文
 * - 只对明确的连接建立超时做一次有限 transport retry
 * - 不自动切换 Provider
 * - 不自动降级
 */
import type {
  ProviderProfile,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderExecutionResult,
  ProviderExecutionStopReason,
  ProviderFailureDetail,
  UsageRecord,
  IdentityConfirmationContext,
  ProviderAdapterResolver,
} from './types';
import { TimeoutError, TransportError, ProviderProtocolError } from './providerErrors';
import { buildChildEnv } from './buildChildEnv';
import { checkModelIdentity } from './modelIdentity';
import { buildUsageRecord } from './usage';
import { computeCostRmbFromPricing } from './cost';
import { redactSecretValues } from './redact';
import type { ModelPricing } from './types';
import { saveRunState, loadRunState, runStateExists } from './store';
import {
  executeWithConnectTimeoutRetry,
  getSafeNetworkErrorCode,
} from './transportRetryPolicy';

/**
 * 构造安全结构化失败摘要——不含密钥/完整请求体/响应体/文件正文。
 * 用于替代退化为 "PROVIDER_ERROR" 的 stopDetail。
 */
function buildProviderFailureDetail(opts: {
  err: Error;
  callId: string;
  providerId: string;
  requestedModelId: string;
  timeoutMs: number;
  credentialValues: string[];
}): ProviderFailureDetail {
  const { err, callId, providerId, requestedModelId, timeoutMs, credentialValues } = opts;
  const secrets = credentialValues;

  // 安全提取 error cause name
  let causeName: string | null = null;
  const errRecord = err as unknown as Record<string, unknown>;
  if (errRecord.cause && typeof errRecord.cause === 'object' && (errRecord.cause as Record<string, unknown>)?.name) {
    causeName = String((errRecord.cause as Record<string, unknown>).name);
    // 检查 cause name 不含密钥
    if (secrets.some(s => causeName!.includes(s))) causeName = '<redacted>';
  }

  // 安全提取网络错误码（与 retry policy 复用同一有界提取逻辑）
  const networkErrorCode = getSafeNetworkErrorCode(err, secrets);

  let errorKind: ProviderFailureDetail['errorKind'];
  let httpStatus: number | null = null;

  if (err instanceof TimeoutError) {
    errorKind = 'TIMEOUT';
  } else if (err instanceof TransportError) {
    errorKind = 'TRANSPORT';
    // TransportError 可能携带 HTTP status（从 cause 中无法提取，保持 null）
  } else if (err instanceof ProviderProtocolError) {
    errorKind = 'UNKNOWN'; // 协议错误属于未知——格式不符合预期
  } else {
    errorKind = 'UNKNOWN';
  }

  const safeMessage = redactSecretValues(
    (err as Error).message?.slice(0, 500) ?? 'unknown',
    secrets,
  );

  return {
    errorClass: err.constructor.name,
    safeMessage,
    errorKind,
    httpStatus,
    networkErrorCode,
    causeName,
    timeoutMs,
    providerId,
    requestedModelId,
    callId,
  };
}

/** 仅当 usage 所有 token 字段非 null 时计算费用，否则返回 null */
function computeCostRmbFromPricingIfUsageComplete(
  usage: import('./types').RawProviderUsage,
  pricing: ModelPricing,
): number | null {
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    usage.cacheCreationInputTokens === null ||
    usage.cacheReadInputTokens === null
  ) {
    return null;
  }
  return computeCostRmbFromPricing(usage, pricing);
}

export interface ExecuteProviderCallOptions {
  profile: ProviderProfile;
  logicalModelName: string;
  role: 'builder' | 'arbiter';
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  adapterRegistry: ProviderAdapterResolver;
  parentEnv: NodeJS.ProcessEnv;
  /** 存储操作的目标目录 */
  cwd: string;
  /** 当前 RunState 的 runId（如果有） */
  runId?: string;
  /** v0.2.0 Slice 1E：多轮对话历史（优先于 systemPrompt/userPrompt） */
  messages?: import('./types').ProviderChatMessage[];
  /** v0.2.0 Slice 1E：工具定义 */
  tools?: import('./types').ProviderToolDefinition[];
  /** v0.2.0 Slice 1E：工具模式，默认 'disabled' */
  toolMode?: import('./types').ProviderToolMode;
  /** 由受信任调用方预生成的调用 ID；不得来自模型输出。 */
  callId?: string;
  /** 本次调用的运行时执行角色；Writer 必须传 WRITER，不得为了归因回退 FAST */
  executionRole?: import('./types').RuntimeExecutionRole | null;
}

/**
 * 执行一次 Provider 调用——完整的 mock transport 闭环。
 */
export async function executeProviderCall(
  opts: ExecuteProviderCallOptions,
): Promise<ProviderExecutionResult> {
  const { profile, logicalModelName, role, adapterRegistry, parentEnv, cwd } = opts;

  // --- 1. 查找模型配置 ---
  const modelIdentity = profile.models.find((m) => m.logicalName === logicalModelName);
  if (!modelIdentity) {
    return {
      ok: false,
      stopReason: 'PRICING_NOT_FOUND',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `Provider "${profile.id}" 中未找到 logicalModelName="${logicalModelName}" 对应的模型配置`,
    };
  }

  const requestedModelId = modelIdentity.requestedModelId;

  // --- 2. 调用前定价检查（requestedModelId 必须有定价）---
  if (!(requestedModelId in profile.pricing)) {
    return {
      ok: false,
      stopReason: 'PRICING_NOT_FOUND',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `模型 "${requestedModelId}" 未在 Provider "${profile.id}" 定价表中——PRICING_NOT_FOUND`,
    };
  }

  // --- 3. 选择 Adapter ---
  const adapter = adapterRegistry.resolve(profile.transport);
  if (!adapter) {
    return {
      ok: false,
      stopReason: 'TRANSPORT_NOT_IMPLEMENTED',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `Provider "${profile.id}" transport="${profile.transport}" 无对应 Adapter——TRANSPORT_NOT_IMPLEMENTED`,
    };
  }

  // --- 4. 构建隔离运行环境 ---
  let childEnv: NodeJS.ProcessEnv;
  try {
    const result = buildChildEnv(profile, parentEnv);
    childEnv = result.childEnv;
  } catch (err) {
    return {
      ok: false,
      stopReason: 'PROVIDER_ERROR',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `环境隔离失败：${(err as Error).message}`,
    };
  }

  // --- 4a. Adapter Profile 预校验（在创建 PendingCall 之前）---
  if (adapter.validateProfile) {
    const validation = adapter.validateProfile(profile);
    if (!validation.ok) {
      return {
        ok: false,
        stopReason: 'PROVIDER_ERROR',
        requiresHumanConfirmation: false,
        usageRecord: null,
        identityConfirmationContext: null,
        message: `Profile "${profile.id}" 预校验失败：${validation.message}`,
      };
    }
  }

  // --- 5. 构建标准化请求 ---
  const callId = opts.callId ?? newCallId();
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(callId)) {
    return {
      ok: false,
      stopReason: 'PROVIDER_ERROR',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: '调用 ID 格式无效',
    };
  }
  const request: ProviderCallRequest = {
    callId,
    providerId: profile.id,
    requestedModelId,
    role,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    maxOutputTokens: opts.maxOutputTokens,
    timeoutMs: opts.timeoutMs,
    messages: opts.messages,
    tools: opts.tools,
    toolMode: opts.toolMode,
  };

  // --- 6. 写入 PendingCall=PREPARED ---
  persistPendingCall(cwd, opts.runId, {
    callId,
    providerId: profile.id,
    requestedModelId,
    role,
    status: 'PREPARED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // --- 7. PendingCall=DISPATCHED，然后调用 Adapter ---
  persistPendingCall(cwd, opts.runId, {
    callId,
    providerId: profile.id,
    requestedModelId,
    role,
    status: 'DISPATCHED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const transportOutcome = await executeWithConnectTimeoutRetry(
    () => adapter.execute(request, { childEnv, timeoutMs: opts.timeoutMs, profile }),
  );
  const transportAudit = transportOutcome.audit;
  const audited = (result: ProviderExecutionResult): ProviderExecutionResult => ({
    ...result,
    transportAudit,
  });

  if (!transportOutcome.ok) {
    const err = transportOutcome.error;
    // 通过 instanceof 稳定判断错误类别（不使用字符串 message 匹配）
    const isTimeout = err instanceof TimeoutError;
    const isDomainError = err instanceof TransportError || err instanceof ProviderProtocolError;

    const marked = markPendingCallUnknown(cwd, opts.runId, callId);
    // 若 mark 失败（pendingCall 不存在或 callId 不匹配）→ 说明内部状态已不一致
    // 不能声称 UNKNOWN_AFTER_CRASH 已持久化

    // TransportError / ProviderProtocolError → known error classes → PROVIDER_ERROR
    // Unless TransportError.transient === true → transientTransportError flag
    // Unknown errors (generic Error, etc.) → truly unknown → UNKNOWN_AFTER_CRASH
    const stopReason: ProviderExecutionStopReason = isTimeout
      ? 'PROVIDER_TIMEOUT'
      : isDomainError
        ? 'PROVIDER_ERROR'
        : 'UNKNOWN_AFTER_CRASH';

    const isTransientTransport =
      err instanceof TransportError && err.transient === true;

    const credentialValues = profile.credentialEnvVars
      .map(name => childEnv[name])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const safeErrorMessage = redactSecretValues((err as Error).message, credentialValues);
    const failureDetail = buildProviderFailureDetail({
      err: err as Error,
      callId,
      providerId: profile.id,
      requestedModelId,
      timeoutMs: opts.timeoutMs,
      credentialValues,
    });

    return audited({
      ok: false,
      stopReason,
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `Provider 调用失败：${safeErrorMessage}` +
        (marked ? '' : '（警告：无法更新 PendingCall 状态，内部状态可能不一致）'),
      errorKind: isTimeout ? 'HTTP' : undefined,
      httpStatus: null,
      // A connect-timeout retry already consumed this logical invocation's
      // only retry budget. Do not let an outer Tool Loop replay it again.
      transientTransportError:
        (isTransientTransport && transportAudit.transportRetryCount === 0) || undefined,
      failureDetail,
    });
  }
  const response: ProviderCallResponse = transportOutcome.value;

  // --- 8. 如果是 Error 响应，记录后根据 error.kind 分类返回 ---
  // Adapter 明确返回 isError=true → Provider 已知失败，是终态，应清除 pendingCall（不是 UNKNOWN_AFTER_CRASH）
  if (response.isError) {
    // unsupported_tool_calls：Provider 已返回模型和用量——做正常身份/Usage/费用计算
    if (response.subtype === 'unsupported_tool_calls') {
      return audited(handleUnsupportedToolCalls(response, profile, requestedModelId, role, opts));
    }

    // 普通 HTTP 错误：requestedModelId 已通过调用前定价检查
    const errorKind = response.error?.kind;
    const errorRecord = buildUsageRecord({
      model: role,
      requestedModelId,
      reportedModel: response.reportedModel,
      providerId: profile.id,
      modelIdentityStatus: 'UNVERIFIED',  // 无可靠 reportedModel
      rawUsage: response.usage,
      pricingStatus: 'PRICED',  // 调用前已确认 requestedModelId 在定价表中
      costRmbCustom: null,       // usage 全部 null，无法计算
      costRmbOfficial: null,
      durationMs: response.durationMs,
      numTurns: response.numTurns,
      subtype: response.subtype,
      isError: true,
      executionRole: opts.executionRole ?? null,
    });

    const stopReason: ProviderExecutionStopReason =
      errorKind === 'AUTH' ? 'PROVIDER_AUTH_ERROR' : 'PROVIDER_ERROR';

    completeKnownCall(cwd, opts.runId, errorRecord);

    return audited({
      ok: false,
      stopReason,
      requiresHumanConfirmation: false,
      usageRecord: errorRecord,
      identityConfirmationContext: null,
      message: `Provider "${profile.id}" 返回错误响应：${response.error?.message ?? response.subtype}`,
      errorKind,
      httpStatus: response.error?.httpStatus ?? null,
    });
  }

  // --- 9. 模型身份判定 ---
  const identityResult = checkModelIdentity(profile, requestedModelId, response.reportedModel);

  // --- 10. 计算费用 ---
  // 实际模型 = reportedModel ?? requestedModelId
  const pricingModelId = response.reportedModel ?? requestedModelId;
  let pricingStatus: 'PRICED' | 'UNPRICED' = 'PRICED';
  let costRmbCustom: number | null = null;

  if (identityResult.status === 'VERIFIED') {
    // reportedModel 非 null 且在白名单中——按 reportedModel 查价
    const pricing = profile.pricing[pricingModelId];
    if (pricing) {
      // 只有 usage 完整时才计算费用，否则保持 null
      costRmbCustom = computeCostRmbFromPricingIfUsageComplete(response.usage, pricing);
    } else {
      // reportedModel 在定价表中不存在——UNPRICED
      pricingStatus = 'UNPRICED';
      costRmbCustom = null;
    }
  } else if (identityResult.status === 'UNVERIFIED') {
    // reportedModel 为 null——无法确认 Provider 实际执行的模型。
    // 定价配置是已确认事实（requestedModelId 已通过调用前定价检查），
    // 因此 pricingStatus='PRICED'（不是 UNPRICED——未知不等于不存在）；
    // 但不能把请求模型估算费用当作确认费用，costRmbCustom=null、costStatus 由 usage 完整性决定。
    pricingStatus = 'PRICED';
    costRmbCustom = null;
  }
  // MISMATCH: costRmbCustom 保持 null

  // --- 11. 构建 UsageRecord ---
  const usageRecord = buildUsageRecord({
    model: role,
    requestedModelId,
    reportedModel: response.reportedModel,
    providerId: profile.id,
    modelIdentityStatus: identityResult.status,
    rawUsage: response.usage,
    pricingStatus,
    costRmbCustom,
    costRmbOfficial: null, // mock transport 无官方费用
    durationMs: response.durationMs,
    numTurns: response.numTurns,
    subtype: response.subtype,
    isError: response.isError,
    executionRole: opts.executionRole ?? null,
  });

  // --- 12. 根据模型身份返回结果 ---
  if (identityResult.status === 'MISMATCH') {
    // MISMATCH → 立即失败，不把内容交给下游
    completeKnownCall(cwd, opts.runId, usageRecord);

    return audited({
      ok: false,
      stopReason: 'MODEL_IDENTITY_MISMATCH',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `模型身份不匹配：${identityResult.detail}`,
    });
  }

  if (identityResult.status === 'UNVERIFIED') {
    // UNVERIFIED → 保存 UsageRecord，清除 pendingCall（调用已完成），进入 HUMAN_GATE
    completeKnownCall(cwd, opts.runId, usageRecord);

    const identityCtx: IdentityConfirmationContext = {
      sourcePhase: 'DS_WORK',
      resumePhase: 'VERIFY',
      pendingResultId: callId,
    };

    return audited({
      ok: false,
      stopReason: null,
      requiresHumanConfirmation: true,
      usageRecord,
      identityConfirmationContext: identityCtx,
      message: `Provider 未返回实际模型 ID，需要人工确认模型身份`,
    });
  }

  // --- 13. VERIFIED → 检查 Usage 完整性 → 检查定价完整性 ---
  if (usageRecord.usageStatus !== 'AVAILABLE') {
    // usage 非完整 → COST_UNAVAILABLE
    completeKnownCall(cwd, opts.runId, usageRecord);

    return audited({
      ok: false,
      stopReason: 'COST_UNAVAILABLE',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `Usage 不完整（${usageRecord.usageStatus}），无法安全计算费用——COST_UNAVAILABLE`,
    });
  }

  if (pricingStatus === 'UNPRICED') {
    completeKnownCall(cwd, opts.runId, usageRecord);

    return audited({
      ok: false,
      stopReason: 'COST_UNAVAILABLE',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `模型身份已验证，但 reportedModel="${pricingModelId}" 不在定价表中——COST_UNAVAILABLE`,
    });
  }

  // --- 14. 成功：追加 UsageRecord，清除 PendingCall ---
  completeKnownCall(cwd, opts.runId, usageRecord);

  return audited({
    ok: true,
    usageRecord,
    content: response.content ?? '',
    toolCalls: response.toolCalls,
    reasoningContent: response.reasoningContent,
  });
}

// ======= PendingCall / Store 操作封装（切片 1B 最小实现） =======

/**
 * 处理 unsupported_tool_calls 错误：Provider 已返回明确响应（含 reportedModel 和 usage）。
 * 执行正常模型身份判定、Usage 标准化和费用计算。
 * 身份 MISMATCH 优先；不把 content 交给正常下游；最终返回 PROVIDER_ERROR。
 */
function handleUnsupportedToolCalls(
  response: ProviderCallResponse,
  profile: ProviderProfile,
  requestedModelId: string,
  role: 'builder' | 'arbiter',
  opts: ExecuteProviderCallOptions,
): ProviderExecutionResult {
  // 正常模型身份判定
  const identityResult = checkModelIdentity(profile, requestedModelId, response.reportedModel);

  // 正常费用计算
  const pricingModelId = response.reportedModel ?? requestedModelId;
  let pricingStatus: 'PRICED' | 'UNPRICED' = 'PRICED';
  let costRmbCustom: number | null = null;

  if (identityResult.status === 'VERIFIED') {
    const pricing = profile.pricing[pricingModelId];
    if (pricing) {
      costRmbCustom = computeCostRmbFromPricingIfUsageComplete(response.usage, pricing);
    } else {
      pricingStatus = 'UNPRICED';
      costRmbCustom = null;
    }
  } else if (identityResult.status === 'UNVERIFIED') {
    pricingStatus = 'PRICED';
    costRmbCustom = null;
  }
  // MISMATCH: costRmbCustom 保持 null

  const usageRecord = buildUsageRecord({
    model: role,
    requestedModelId,
    reportedModel: response.reportedModel,
    providerId: profile.id,
    modelIdentityStatus: identityResult.status,
    rawUsage: response.usage,
    pricingStatus,
    costRmbCustom,
    costRmbOfficial: null,
    durationMs: response.durationMs,
    numTurns: response.numTurns,
    subtype: response.subtype,
    isError: true,
    executionRole: opts.executionRole ?? null,
  });

  // 身份 MISMATCH 优先（安全门禁）
  if (identityResult.status === 'MISMATCH') {
    completeKnownCall(opts.cwd, opts.runId, usageRecord);
    return {
      ok: false,
      stopReason: 'MODEL_IDENTITY_MISMATCH',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `unsupported_tool_calls 且模型身份不匹配：${identityResult.detail}`,
    };
  }

  // 其他情况：已知错误终态，清除 pendingCall，不进入 HUMAN_GATE
  completeKnownCall(opts.cwd, opts.runId, usageRecord);
  return {
    ok: false,
    stopReason: 'PROVIDER_ERROR',
    requiresHumanConfirmation: false,
    usageRecord,
    identityConfirmationContext: null,
    message: `Provider "${profile.id}" 返回 unsupported_tool_calls（当前切片不支持工具调用）`,
  };
}

/**
 * 纯内存 helper：将 terminal PendingCall 追加到 state.attemptHistory。
 * 不 load、不 save——调用方负责在调用前后管理持久化。
 * 去重：同 callId 不重复追加。
 */
function appendAttemptHistoryToState(
  state: import('./store').RunState,
  call: import('./types').PendingCall,
): void {
  if (!state.attemptHistory) state.attemptHistory = [];
  if (state.attemptHistory.some((c) => c.callId === call.callId)) return;
  state.attemptHistory.push(call);
}

/**
 * 已知终态：一次 loadRunState + 一次 saveRunState 完成 calls[] 追加 + pendingCall 清除 + attemptHistory 追加。
 * 不允许先单独 save calls[] 再单独 clear pendingCall —— 那样会留下半完成状态的窗口。
 * B5 fix: 所有 mutation 在同一 state 对象上完成，单次 save，不再调用 appendAttemptHistory（后者独立 load/save 造成 state 覆盖）。
 */
function completeKnownCall(
  cwd: string,
  runId: string | undefined,
  record: UsageRecord,
): void {
  if (!runId || !runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  // P0.1 / B5: Archive terminal COMPLETED attempt to attemptHistory (pure append, no I/O).
  if (state.pendingCall) {
    const terminalCall: import('./types').PendingCall = {
      ...state.pendingCall,
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
    };
    appendAttemptHistoryToState(state, terminalCall);
  }
  state.calls.push({
    callId: state.pendingCall?.callId ?? record.requestedModelId,
    model: record.model,
    modelId: record.requestedModelId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheCreationInputTokens: record.cacheCreationInputTokens,
    cacheReadInputTokens: record.cacheReadInputTokens,
    costUsd: 0,
    costRmbOfficial: record.costRmbOfficial ?? 0,
    costRmbCustom: record.costRmbCustom,
    costRmb: record.costRmbCustom,
    durationMs: record.durationMs ?? 0,
    numTurns: record.numTurns,
    pricingStatus: record.pricingStatus,
    subtype: record.subtype,
    isError: record.isError,
    permissionDenialsCount: record.permissionDenialsCount,
    executionRole: record.executionRole ?? null,
  });
  state.pendingCall = undefined;
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/**
 * 未知终态（timeout / 异常崩溃）：将现有 DISPATCHED 的 pendingCall 转为 UNKNOWN_AFTER_CRASH。
 * 校验：pendingCall 必须存在且 callId 匹配，否则 fail closed。
 * 保留原有所有字段（时间、Provider、模型、角色及其他上下文），仅修改 status + updatedAt。
 * 不根据传入参数重建一条精简 PendingCall。
 * 不追加 calls[]。
 *
 * B5 fix: attemptHistory append + pendingCall.status mutation 在同一 load/save 内完成。
 *
 * @returns true 表示已成功修改并持久化；false 表示 pendingCall 不存在或 callId 不匹配。
 */
function markPendingCallUnknown(
  cwd: string,
  runId: string | undefined,
  callId: string,
): boolean {
  if (!runId || !runStateExists(cwd, runId)) return false;
  const state = loadRunState(cwd, runId);

  // pendingCall 不存在 → fail closed，不凭空创建
  if (!state.pendingCall) return false;

  // callId 不匹配 → fail closed，不修改其他 PendingCall
  if (state.pendingCall.callId !== callId) return false;

  // B5: Archive terminal UNKNOWN_AFTER_CRASH in-memory (pure append, no separate I/O)
  const terminalCall: import('./types').PendingCall = {
    ...state.pendingCall,
    status: 'UNKNOWN_AFTER_CRASH',
    updatedAt: new Date().toISOString(),
  };
  appendAttemptHistoryToState(state, terminalCall);

  // 仅修改 status，保留所有原有字段
  state.pendingCall.status = 'UNKNOWN_AFTER_CRASH';
  state.pendingCall.updatedAt = new Date().toISOString();
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
  return true;
}

function persistPendingCall(cwd: string, runId: string | undefined, pendingCall: import('./types').PendingCall): void {
  if (!runId || !runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  state.pendingCall = pendingCall;
  state.updatedAt = new Date().toISOString();
  saveRunState(cwd, state);
}

/** 生成 callId（足够随机、防碰撞） */
export function newCallId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `call-${Date.now()}-${rand}`;
}
