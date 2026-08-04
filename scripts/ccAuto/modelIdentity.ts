/** cc-auto v0.2.0 Slice 1B — 模型身份判定。
 *
 * 规则：
 * - reportedModel === null → UNVERIFIED
 * - reportedModel 在对应 ModelIdentity.acceptedReportedModelIds 内 → VERIFIED
 * - 否则 → MISMATCH
 * - 不得直接比较 ProviderProfile.id 与 reportedModel
 * - 不得因渠道别名自动扩大白名单
 * - acceptedReportedModelIds 只来自配置
 */
import type { ModelIdentityStatus, ModelIdentity, ProviderProfile } from './types';

export interface IdentityCheckResult {
  status: ModelIdentityStatus;
  /** VERIFIED 时为空，MISMATCH/UNVERIFIED 时提供描述 */
  detail: string;
}

/**
 * 对单次 Provider 响应执行模型身份判定。
 *
 * @param profile 发起调用的 ProviderProfile——用于查找 matchingModel 的白名单
 * @param requestedModelId 请求时指定的模型 ID（逻辑名）
 * @param reportedModel Provider 响应中返回的实际模型 ID（可能为 null）
 */
export function checkModelIdentity(
  profile: ProviderProfile,
  requestedModelId: string,
  reportedModel: string | null,
): IdentityCheckResult {
  // reportedModel === null → UNVERIFIED
  if (reportedModel === null) {
    return {
      status: 'UNVERIFIED',
      detail: `Provider "${profile.id}" 未返回实际模型 ID（reportedModel=null），无法验证模型身份`,
    };
  }

  // 查找请求模型对应的 ModelIdentity
  const modelIdentity = profile.models.find((m) => m.requestedModelId === requestedModelId);
  if (!modelIdentity) {
    // requestedModelId 不在配置中——这是一个配置错误
    return {
      status: 'MISMATCH',
      detail: `requestedModelId "${requestedModelId}" 不在 Provider "${profile.id}" 的 models 配置中`,
    };
  }

  // 检查 reportedModel 是否在白名单中
  if (modelIdentity.acceptedReportedModelIds.includes(reportedModel)) {
    return {
      status: 'VERIFIED',
      detail: '',
    };
  }

  return {
    status: 'MISMATCH',
    detail: `Provider 返回模型 "${reportedModel}" 不在 logicalName="${modelIdentity.logicalName}" 的 acceptedReportedModelIds 白名单中`,
  };
}

/**
 * 查找 ProviderProfile 中 logicalName 对应的 ModelIdentity。
 * 用于 Executor 在请求前查找 requestedModelId 对应的模型配置。
 */
export function findModelByIdentityLogicalName(
  profile: ProviderProfile,
  logicalName: string,
): ModelIdentity | undefined {
  return profile.models.find((m) => m.logicalName === logicalName);
}
