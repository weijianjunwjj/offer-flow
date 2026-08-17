/** cc-auto v0.2.0 Provider 配置加载与校验。
 *
 * 职责：
 * - 从 CcAutoConfig.providerProfiles 加载 ProviderProfile 配置
 * - 校验 defaultModelId / requestedModelId / pricing / currency / credential safety
 * - 所有校验错误 fail closed
 * - 不保存任何密钥正文，只保存凭证环境变量名称
 */
import type {
  ContextPricingTier,
  ModelIdentity,
  ModelPricing,
  ProviderConfigLoadResult,
  ProviderProfile,
  TokenPricingRates,
} from './types';
import type { CcAutoConfig } from './config';
import { checkProfileEnvConflicts, formatEnvConflicts } from './envNamespace';

/** 从 CcAutoConfig.providerProfiles 加载并校验 Provider 配置。不读取额外文件。 */
export function loadProviderProfiles(config: CcAutoConfig): ProviderConfigLoadResult {
  if (!config.providerProfiles || typeof config.providerProfiles !== 'object') {
    return {
      ok: false,
      reason: 'FILE_NOT_FOUND',
      error: '配置 .cc-auto/config.json 中缺少 providerProfiles 字段。请在该文件中添加 Provider 配置。',
    };
  }

  const raw = config.providerProfiles;
  const profiles: Record<string, ProviderProfile> = {};

  for (const [id, entry] of Object.entries(raw)) {
    const result = validateProviderProfile(id, entry);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.kind === 'PRICING_NOT_FOUND' ? 'PRICING_NOT_FOUND' : 'VALIDATION_ERROR',
        error: `Profile "${id}" 校验失败：${result.error}`,
      };
    }
    profiles[id] = result.profile!;
  }

  if (Object.keys(profiles).length === 0) {
    return { ok: false, error: 'providerProfiles 中没有有效的 Profile' };
  }

  return { ok: true, profiles };
}

/** 校验单个 ProviderProfile */
export function validateProviderProfile(
  id: string,
  entry: unknown,
): { ok: boolean; profile?: ProviderProfile; error?: string; kind?: 'GENERAL' | 'PRICING_NOT_FOUND' } {
  if (!entry || typeof entry !== 'object') {
    return { ok: false, error: '必须是非 null 对象' };
  }

  const e = entry as Record<string, unknown>;

  // --- 必填字符串字段 ---
  if (typeof e.displayName !== 'string' || e.displayName.trim().length === 0) {
    return { ok: false, error: 'displayName 必须是有效字符串' };
  }
  if (typeof e.defaultModelId !== 'string' || e.defaultModelId.trim().length === 0) {
    return { ok: false, error: 'defaultModelId 必须是有效字符串' };
  }

  // --- vendor ---
  if (!['deepseek', 'anthropic', 'third-party'].includes(e.vendor as string)) {
    return { ok: false, error: `vendor 必须是 'deepseek' | 'anthropic' | 'third-party'，收到 ${JSON.stringify(e.vendor)}` };
  }

  // --- transport ---
  if (!['openai-chat', 'anthropic-messages', 'claude-cli'].includes(e.transport as string)) {
    return { ok: false, error: `transport 必须是 'openai-chat' | 'anthropic-messages' | 'claude-cli'，收到 ${JSON.stringify(e.transport)}` };
  }

  // --- apiBaseUrl: 可选，但如果提供必须是字符串 ---
  if (e.apiBaseUrl !== undefined && typeof e.apiBaseUrl !== 'string') {
    return { ok: false, error: 'apiBaseUrl 如果提供必须是字符串' };
  }

  // --- credentialEnvVars ---
  if (!Array.isArray(e.credentialEnvVars) || !e.credentialEnvVars.every((v) => typeof v === 'string')) {
    return { ok: false, error: 'credentialEnvVars 必须是字符串数组' };
  }

  // --- runtimeEnvAllowlist ---
  if (!Array.isArray(e.runtimeEnvAllowlist) || !e.runtimeEnvAllowlist.every((v) => typeof v === 'string')) {
    return { ok: false, error: 'runtimeEnvAllowlist 必须是字符串数组' };
  }

  // --- 环境变量命名空间冲突检查（在所有其他校验之后、构造 profile 之前）---
  // 必须在 staticEnv 模式检查之前执行——精确命名空间匹配优先于模式猜测。
  {
    const creds = (e.credentialEnvVars as string[] | undefined) ?? [];
    const allowlist = (e.runtimeEnvAllowlist as string[] | undefined) ?? [];
    // 使用临时 profile 对象——仅提供冲突检查所需字段
    const tempProfile = {
      credentialEnvVars: creds,
      runtimeEnvAllowlist: allowlist,
      staticEnv: e.staticEnv as Record<string, string> | undefined,
    } as ProviderProfile;
    const nsConflicts = checkProfileEnvConflicts(tempProfile);
    if (nsConflicts.length > 0) {
      return {
        ok: false,
        error: `环境变量命名空间冲突：${formatEnvConflicts(nsConflicts)}`,
      };
    }
  }

  // --- staticEnv: 禁止明显凭证字段（补充保护——检查值层面的模式，而不仅仅是变量名冲突）---
  if (e.staticEnv !== undefined) {
    if (typeof e.staticEnv !== 'object' || e.staticEnv === null || Array.isArray(e.staticEnv)) {
      return { ok: false, error: 'staticEnv 必须是对象或省略' };
    }
    const staticEnv = e.staticEnv as Record<string, unknown>;
    const credentialPatterns = [
      'key', 'secret', 'token', 'password', 'passwd',
      'auth', 'credential', 'apikey', 'api_key',
    ];
    for (const key of Object.keys(staticEnv)) {
      const lower = key.toLowerCase();
      if (credentialPatterns.some((p) => lower.includes(p))) {
        return {
          ok: false,
          error: `staticEnv 包含疑似凭证字段 "${key}"——凭证只能通过 credentialEnvVars 声明名称，不得存入 staticEnv`,
        };
      }
      if (typeof staticEnv[key] !== 'string') {
        return { ok: false, error: `staticEnv["${key}"] 必须是字符串` };
      }
    }
  }

  // --- models ---
  if (!Array.isArray(e.models) || e.models.length === 0) {
    return { ok: false, error: 'models 必须是至少包含 1 项的数组' };
  }
  const models: ModelIdentity[] = [];
  for (let i = 0; i < (e.models as unknown[]).length; i++) {
    const m = (e.models as unknown[])[i];
    const model = validateModelIdentity(m);
    if (!model.ok) {
      return { ok: false, error: `models[${i}] 校验失败：${model.error}` };
    }
    models.push(model.identity!);
  }

  // --- 校验 defaultModelId 在 models 中存在 ---
  if (!models.some((m) => m.logicalName === e.defaultModelId)) {
    return { ok: false, error: `defaultModelId "${e.defaultModelId}" 不在 models 列表的任何 logicalName 中` };
  }

  // --- pricing ---
  if (!e.pricing || typeof e.pricing !== 'object' || Array.isArray(e.pricing)) {
    return { ok: false, error: 'pricing 必须是对象（按模型 ID 索引）' };
  }
  const pricing: Record<string, ModelPricing> = {};
  for (const [modelId, p] of Object.entries(e.pricing as Record<string, unknown>)) {
    const result = validateModelPricing(modelId, p);
    if (!result.ok) {
      return { ok: false, error: `pricing["${modelId}"] 校验失败：${result.error}` };
    }
    pricing[modelId] = result.pricing!;
  }

  // --- 校验每个 model 的 requestedModelId 在 pricing 中有定价 ---
  for (const model of models) {
    if (!pricing[model.requestedModelId]) {
      return {
        ok: false,
        kind: 'PRICING_NOT_FOUND',
        error: `模型 logicalName="${model.logicalName}" 的 requestedModelId "${model.requestedModelId}" 未在 pricing 中找到——PRICING_NOT_FOUND（配置态）`,
      };
    }
  }

  // --- 环境变量命名空间冲突检查（大小写不敏感）---
  const profile: ProviderProfile = {
    id,
    displayName: e.displayName as string,
    vendor: e.vendor as ProviderProfile['vendor'],
    transport: e.transport as ProviderProfile['transport'],
    apiBaseUrl: e.apiBaseUrl as string | undefined,
    credentialEnvVars: e.credentialEnvVars as string[],
    runtimeEnvAllowlist: e.runtimeEnvAllowlist as string[],
    staticEnv: e.staticEnv as Record<string, string> | undefined,
    defaultModelId: e.defaultModelId as string,
    models,
    pricing,
  };

  const conflicts = checkProfileEnvConflicts(profile);
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `环境变量命名空间冲突：${formatEnvConflicts(conflicts)}`,
    };
  }

  return { ok: true, profile };
}

function validateModelIdentity(
  m: unknown,
): { ok: boolean; identity?: ModelIdentity; error?: string } {
  if (!m || typeof m !== 'object') {
    return { ok: false, error: '必须是非 null 对象' };
  }
  const o = m as Record<string, unknown>;

  if (typeof o.logicalName !== 'string' || o.logicalName.trim().length === 0) {
    return { ok: false, error: 'logicalName 必须是有效字符串' };
  }
  if (typeof o.requestedModelId !== 'string' || o.requestedModelId.trim().length === 0) {
    return { ok: false, error: 'requestedModelId 必须是有效字符串' };
  }
  if (!Array.isArray(o.acceptedReportedModelIds) || !o.acceptedReportedModelIds.every((v) => typeof v === 'string')) {
    return { ok: false, error: 'acceptedReportedModelIds 必须是字符串数组' };
  }
  if (o.acceptedReportedModelIds.length === 0) {
    return { ok: false, error: 'acceptedReportedModelIds 不能为空数组' };
  }
  if (typeof o.displayName !== 'string' || o.displayName.trim().length === 0) {
    return { ok: false, error: 'displayName 必须是有效字符串' };
  }

  return {
    ok: true,
    identity: {
      logicalName: o.logicalName as string,
      requestedModelId: o.requestedModelId as string,
      acceptedReportedModelIds: o.acceptedReportedModelIds as string[],
      displayName: o.displayName as string,
    },
  };
}

export function validateModelPricing(
  _modelId: string,
  p: unknown,
): { ok: boolean; pricing?: ModelPricing; error?: string } {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, error: '必须是非 null 对象' };
  }
  const o = p as Record<string, unknown>;

  const metadata = validatePricingMetadata(o);
  if (!metadata.ok) return metadata;

  if (o.pricingType === 'context-tiered') {
    return validateContextTieredPricing(o, metadata.value!);
  }
  if (o.pricingType !== undefined && o.pricingType !== 'flat') {
    return { ok: false, error: `pricingType 必须是 'flat' | 'context-tiered'，收到 ${JSON.stringify(o.pricingType)}` };
  }

  const rates = validateTokenPricingRates(o);
  if (!rates.ok) return rates;

  return {
    ok: true,
    pricing: {
      ...(o.pricingType === 'flat' ? { pricingType: 'flat' as const } : {}),
      ...rates.value!,
      ...metadata.value!,
    },
  };
}

function validateContextTieredPricing(
  o: Record<string, unknown>,
  metadata: Pick<ModelPricing, 'currency' | 'source' | 'updatedAt'>,
): { ok: boolean; pricing?: ModelPricing; error?: string } {
  if (o.thresholdBasis !== 'REQUEST_CONTEXT_TOKENS') {
    return {
      ok: false,
      error: `thresholdBasis 必须为 'REQUEST_CONTEXT_TOKENS'，收到 ${JSON.stringify(o.thresholdBasis)}`,
    };
  }
  if (!Array.isArray(o.tiers) || o.tiers.length === 0) {
    return { ok: false, error: 'tiers 必须是至少包含 1 项的数组' };
  }

  const tiers: ContextPricingTier[] = [];
  const ids = new Set<string>();
  let expectedFromInclusive = 0;

  for (let index = 0; index < o.tiers.length; index += 1) {
    const rawTier = o.tiers[index];
    if (!rawTier || typeof rawTier !== 'object' || Array.isArray(rawTier)) {
      return { ok: false, error: `tiers[${index}] 必须是非 null 对象` };
    }
    const tier = rawTier as Record<string, unknown>;
    if (typeof tier.id !== 'string' || tier.id.trim().length === 0) {
      return { ok: false, error: `tiers[${index}].id 必须是有效字符串` };
    }
    if (ids.has(tier.id)) {
      return { ok: false, error: `tier id 重复：${tier.id}` };
    }
    ids.add(tier.id);
    if (!Number.isInteger(tier.fromInclusive) || (tier.fromInclusive as number) < 0) {
      return { ok: false, error: `tiers[${index}].fromInclusive 必须为非负整数` };
    }
    const fromInclusive = tier.fromInclusive as number;
    if (fromInclusive < expectedFromInclusive) {
      return { ok: false, error: `tiers[${index}] 与上一档重叠（overlap）` };
    }
    if (fromInclusive > expectedFromInclusive) {
      return { ok: false, error: `tiers[${index}] 与上一档之间存在空档（gap）` };
    }

    const upToInclusive = tier.upToInclusive;
    if (upToInclusive !== null
      && (!Number.isInteger(upToInclusive) || (upToInclusive as number) < fromInclusive)) {
      return { ok: false, error: `tiers[${index}].upToInclusive 必须为不小于 fromInclusive 的整数或 null` };
    }
    if (upToInclusive === null && index !== o.tiers.length - 1) {
      return { ok: false, error: `tiers[${index}] catch-all 必须是最后一档` };
    }
    if (!tier.rates || typeof tier.rates !== 'object' || Array.isArray(tier.rates)) {
      return { ok: false, error: `tiers[${index}].rates 必须是非 null 对象` };
    }
    const rates = validateTokenPricingRates(tier.rates as Record<string, unknown>);
    if (!rates.ok) return { ok: false, error: `tiers[${index}].rates 校验失败：${rates.error}` };

    tiers.push({
      id: tier.id,
      fromInclusive,
      upToInclusive: upToInclusive as number | null,
      rates: rates.value!,
    });
    if (upToInclusive !== null) expectedFromInclusive = (upToInclusive as number) + 1;
  }

  if (tiers.at(-1)?.upToInclusive !== null) {
    return { ok: false, error: 'tiers 必须包含最终 catch-all 档（upToInclusive=null）' };
  }

  return {
    ok: true,
    pricing: {
      pricingType: 'context-tiered',
      thresholdBasis: 'REQUEST_CONTEXT_TOKENS',
      tiers,
      ...metadata,
    },
  };
}

function validateTokenPricingRates(
  o: Record<string, unknown>,
): { ok: boolean; value?: TokenPricingRates; error?: string } {

  const numericFields = [
    'inputPerMTokens',
    'outputPerMTokens',
    'cacheCreationPerMTokens',
    'cacheReadPerMTokens',
  ] as const;

  for (const field of numericFields) {
    if (typeof o[field] !== 'number') {
      return { ok: false, error: `${field} 必须是数字` };
    }
    const value = o[field] as number;
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${field} 必须为非负有穷值，收到 ${value}` };
    }
  }

  return {
    ok: true,
    value: {
      inputPerMTokens: o.inputPerMTokens as number,
      outputPerMTokens: o.outputPerMTokens as number,
      cacheCreationPerMTokens: o.cacheCreationPerMTokens as number,
      cacheReadPerMTokens: o.cacheReadPerMTokens as number,
    },
  };
}

function validatePricingMetadata(
  o: Record<string, unknown>,
): { ok: boolean; value?: Pick<ModelPricing, 'currency' | 'source' | 'updatedAt'>; error?: string } {

  // --- currency 必须为 CNY ---
  if (o.currency !== 'CNY') {
    return {
      ok: false,
      error: `currency 必须为 'CNY'（v0.2.0 仅支持人民币定价），收到 ${JSON.stringify(o.currency)}`,
    };
  }

  if (typeof o.source !== 'string' || o.source.trim().length === 0) {
    return { ok: false, error: 'source 必须是有效字符串（价格来源标识）' };
  }

  if (typeof o.updatedAt !== 'string' || o.updatedAt.trim().length === 0) {
    return { ok: false, error: 'updatedAt 必须是有效 ISO 8601 日期字符串' };
  }

  return {
    ok: true,
    value: {
      currency: 'CNY',
      source: o.source as string,
      updatedAt: o.updatedAt as string,
    },
  };
}

/** 检查单个 Profile 的 requestedModelId 是否有定价（供预算预检调用） */
export function modelHasPricing(
  profile: ProviderProfile,
  modelLogicalName: string,
): boolean {
  const model = profile.models.find((m) => m.logicalName === modelLogicalName);
  if (!model) return false;
  return model.requestedModelId in profile.pricing;
}
