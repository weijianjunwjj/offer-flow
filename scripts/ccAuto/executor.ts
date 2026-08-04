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
 * - 不自动重试
 * - 不自动切换 Provider
 * - 不自动降级
 */
import type {
  ProviderProfile,
  ProviderCallRequest,
  ProviderCallResponse,
  ProviderExecutionResult,
  UsageRecord,
  IdentityConfirmationContext,
} from './types';
import type { AdapterRegistry } from './adapter';
import { buildChildEnv } from './buildChildEnv';
import { checkModelIdentity } from './modelIdentity';
import { buildUsageRecord } from './usage';
import { computeCostRmbFromPricing } from './cost';
import type { ModelPricing } from './types';
import { saveRunState, loadRunState, runStateExists } from './store';

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
  adapterRegistry: AdapterRegistry;
  parentEnv: NodeJS.ProcessEnv;
  /** 存储操作的目标目录 */
  cwd: string;
  /** 当前 RunState 的 runId（如果有） */
  runId?: string;
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

  // --- 5. 构建标准化请求 ---
  const callId = newCallId();
  const request: ProviderCallRequest = {
    callId,
    providerId: profile.id,
    requestedModelId,
    role,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    maxOutputTokens: opts.maxOutputTokens,
    timeoutMs: opts.timeoutMs,
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

  let response: ProviderCallResponse;
  try {
    response = await adapter.execute(request, { childEnv, timeoutMs: opts.timeoutMs });
  } catch (err) {
    // Provider 抛错或 timeout：无法确认是否实际执行 → UNKNOWN_AFTER_CRASH
    // 不追加 calls[]（无明确 Provider 调用结果），仅保留 pendingCall 标记
    const isTimeout = (err as Error).name === 'TimeoutError' || (err as Error).message?.includes('timeout');

    const marked = markPendingCallUnknown(cwd, opts.runId, callId);
    // 若 mark 失败（pendingCall 不存在或 callId 不匹配）→ 说明内部状态已不一致
    // 不能声称 UNKNOWN_AFTER_CRASH 已持久化

    return {
      ok: false,
      stopReason: isTimeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR',
      requiresHumanConfirmation: false,
      usageRecord: null,
      identityConfirmationContext: null,
      message: `Provider 调用失败：${(err as Error).message}` +
        (marked ? '' : '（警告：无法更新 PendingCall 状态，内部状态可能不一致）'),
    };
  }

  // --- 8. 如果是 Error 响应，记录后直接返回 PROVIDER_ERROR ---
  // Adapter 明确返回 isError=true → Provider 已知失败，是终态，应清除 pendingCall（不是 UNKNOWN_AFTER_CRASH）
  if (response.isError) {
    const errorRecord = buildUsageRecord({
      model: role,
      requestedModelId,
      reportedModel: response.reportedModel,
      providerId: profile.id,
      modelIdentityStatus: 'UNVERIFIED',
      rawUsage: response.usage,
      pricingStatus: 'UNPRICED',
      costRmbCustom: null,
      costRmbOfficial: null,
      durationMs: response.durationMs,
      numTurns: response.numTurns,
      subtype: response.subtype,
      isError: true,
    });

    completeKnownCall(cwd, opts.runId, errorRecord);

    return {
      ok: false,
      stopReason: 'PROVIDER_ERROR',
      requiresHumanConfirmation: false,
      usageRecord: errorRecord,
      identityConfirmationContext: null,
      message: `Provider "${profile.id}" 返回错误响应：subtype=${response.subtype}`,
    };
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
  });

  // --- 12. 根据模型身份返回结果 ---
  if (identityResult.status === 'MISMATCH') {
    // MISMATCH → 立即失败，不把内容交给下游
    completeKnownCall(cwd, opts.runId, usageRecord);

    return {
      ok: false,
      stopReason: 'MODEL_IDENTITY_MISMATCH',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `模型身份不匹配：${identityResult.detail}`,
    };
  }

  if (identityResult.status === 'UNVERIFIED') {
    // UNVERIFIED → 保存 UsageRecord，清除 pendingCall（调用已完成），进入 HUMAN_GATE
    completeKnownCall(cwd, opts.runId, usageRecord);

    const identityCtx: IdentityConfirmationContext = {
      sourcePhase: 'DS_WORK',
      resumePhase: 'VERIFY',
      pendingResultId: callId,
    };

    return {
      ok: false,
      stopReason: null,
      requiresHumanConfirmation: true,
      usageRecord,
      identityConfirmationContext: identityCtx,
      message: `Provider 未返回实际模型 ID，需要人工确认模型身份`,
    };
  }

  // --- 13. VERIFIED → 检查 Usage 完整性 → 检查定价完整性 ---
  if (usageRecord.usageStatus !== 'AVAILABLE') {
    // usage 非完整 → COST_UNAVAILABLE
    completeKnownCall(cwd, opts.runId, usageRecord);

    return {
      ok: false,
      stopReason: 'COST_UNAVAILABLE',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `Usage 不完整（${usageRecord.usageStatus}），无法安全计算费用——COST_UNAVAILABLE`,
    };
  }

  if (pricingStatus === 'UNPRICED') {
    completeKnownCall(cwd, opts.runId, usageRecord);

    return {
      ok: false,
      stopReason: 'COST_UNAVAILABLE',
      requiresHumanConfirmation: false,
      usageRecord,
      identityConfirmationContext: null,
      message: `模型身份已验证，但 reportedModel="${pricingModelId}" 不在定价表中——COST_UNAVAILABLE`,
    };
  }

  // --- 14. 成功：追加 UsageRecord，清除 PendingCall ---
  completeKnownCall(cwd, opts.runId, usageRecord);

  return {
    ok: true,
    usageRecord,
    content: response.content,
  };
}

// ======= PendingCall / Store 操作封装（切片 1B 最小实现） =======

/**
 * 已知终态：一次 loadRunState + 一次 saveRunState 完成 calls[] 追加 + pendingCall 清除。
 * 不允许先单独 save calls[] 再单独 clear pendingCall —— 那样会留下半完成状态的窗口。
 */
function completeKnownCall(
  cwd: string,
  runId: string | undefined,
  record: UsageRecord,
): void {
  if (!runId || !runStateExists(cwd, runId)) return;
  const state = loadRunState(cwd, runId);
  state.calls.push({
    model: record.model,
    modelId: record.requestedModelId,
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    cacheCreationInputTokens: record.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: record.cacheReadInputTokens ?? 0,
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
