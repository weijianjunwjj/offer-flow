/**
 * V8-3 exact identity 解析（保守，两层，provider-aware）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §4。
 *
 * 严格边界：
 * - Tier 1：providerKey + externalRecordId（均非空）；
 * - Tier 2：providerKey + verifiedCanonicalSourceUrl（URL 必须是岗位详情身份 URL）；
 * - Tier 2 多命中 → identity_conflict，绝不任取其一；
 * - providerKey 为空 → 不做 Tier 2 自动合并；
 * - 同 externalRecordId 跨 provider 不合并（Tier 1 键含 providerKey）；
 * - 不使用内容/相似度做自动合并。
 */
import type { RadarSourceRecord } from '../../src/domain/radar';
import { canonicalizeSourceUrl } from './canonicalUrl';

export type IdentityDecisionKind = 'exact_existing' | 'new_source' | 'identity_conflict';

export interface IdentityDecision {
  kind: IdentityDecisionKind;
  /** exact_existing 时命中的来源记录。 */
  matched: RadarSourceRecord | null;
  /** 用于新建来源时写入的 canonical URL（仅在可用于身份时非 null）。 */
  canonicalSourceUrl: string | null;
  /** 解析所用层级或冲突原因，便于诊断与审计。 */
  reason: string;
}

export interface IdentityResolutionInput {
  providerKey: string | null;
  externalRecordId: string | null;
  /** 原始来源 URL（未 canonical）。 */
  sourceUrl: string | null;
}

export interface IdentityLookups {
  findByProviderKey(providerKey: string, externalRecordId: string): RadarSourceRecord | null;
  findAllByProviderAndUrl(providerKey: string, normalizedSourceUrl: string): RadarSourceRecord[];
}

/**
 * 解析 exact identity。纯函数：所有 DB 访问通过 lookups 注入，便于单测。
 */
export function resolveIdentity(
  input: IdentityResolutionInput,
  lookups: IdentityLookups,
): IdentityDecision {
  const canonical = canonicalizeSourceUrl(input.sourceUrl);

  // Tier 1：providerKey + externalRecordId 均非空。
  if (input.providerKey !== null && input.externalRecordId !== null) {
    const hit = lookups.findByProviderKey(input.providerKey, input.externalRecordId);
    if (hit !== null) {
      return { kind: 'exact_existing', matched: hit, canonicalSourceUrl: usableCanonical(canonical), reason: 'tier1_provider_external' };
    }
    // Tier 1 键齐全但未命中：这是明确的新来源（不再降级到 Tier 2，避免跨键误并）。
    return { kind: 'new_source', matched: null, canonicalSourceUrl: usableCanonical(canonical), reason: 'tier1_miss_new_source' };
  }

  // Tier 2：providerKey 非空 + 可用于身份的 canonical URL。
  if (input.providerKey !== null && canonical.usableForIdentity && canonical.canonicalUrl !== null) {
    // provider 一致性：canonical 识别出的 provider 必须与传入 providerKey 一致，否则不 Tier2。
    if (canonical.providerKey !== null && canonical.providerKey !== input.providerKey) {
      return { kind: 'new_source', matched: null, canonicalSourceUrl: canonical.canonicalUrl, reason: 'tier2_provider_mismatch_new_source' };
    }
    const hits = lookups.findAllByProviderAndUrl(input.providerKey, canonical.canonicalUrl);
    if (hits.length === 1) {
      return { kind: 'exact_existing', matched: hits[0]!, canonicalSourceUrl: canonical.canonicalUrl, reason: 'tier2_provider_url' };
    }
    if (hits.length >= 2) {
      return { kind: 'identity_conflict', matched: null, canonicalSourceUrl: canonical.canonicalUrl, reason: 'tier2_multiple_matches' };
    }
    return { kind: 'new_source', matched: null, canonicalSourceUrl: canonical.canonicalUrl, reason: 'tier2_miss_new_source' };
  }

  // 无 Tier 1 键、无可用于身份的 URL → 隔离的新来源（宁可分裂不可误并）。
  return {
    kind: 'new_source',
    matched: null,
    canonicalSourceUrl: usableCanonical(canonical),
    reason: input.providerKey === null ? 'no_provider_key_isolated' : 'no_stable_identity_isolated',
  };
}

/** 仅当 canonical 可用于身份时返回其 URL，否则 null（不把不可用 URL 当稳定身份）。 */
function usableCanonical(canonical: ReturnType<typeof canonicalizeSourceUrl>): string | null {
  return canonical.usableForIdentity ? canonical.canonicalUrl : null;
}
