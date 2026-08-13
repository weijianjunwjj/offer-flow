/**
 * v0.9 Phase 5A — Evidence Upgrade Persistence 契约类型（纯类型，无实现）。
 *
 * 设计依据：Phase 5A Implementation Scope Lock v3 + Idempotency / Stale Ordering Amendment。
 *
 * 结果契约四态（status 不再扩展）：
 *   - UPGRADED：首次成功创建 evidence_upgrade 版本；
 *   - ALREADY_UPGRADED：幂等 / 重复内容识别，零写入；
 *   - BLOCKED：业务前置条件不满足（零写入，reasonCode 稳定枚举）；
 *   - FAILED：不变量违规 / content hash collision（零写入，reasonCode 稳定枚举）。
 */

import type { EvidenceValidationResult, ExtractedContent } from '../../content-acquisition/types';

export interface EvidenceUpgradeInput {
  /** 升级目标：SEARCH_EVIDENCE 来源版本 ID。candidateId / sourceUrl 一律从它派生。 */
  sourceVersionId: string;
  /** Content Acquisition 成功提取的有界内容（title/plainText/canonicalUrl/contentType）。 */
  content: ExtractedContent;
  /** JD 完整性 / 证据验证结果（PASS 才 eligible，不等于 FULL_EVIDENCE）。 */
  validation: EvidenceValidationResult;
}

/** 稳定、机器可读的 BLOCKED reason code。 */
export const EVIDENCE_UPGRADE_BLOCK_REASONS = [
  'validation_not_eligible',
  'invalid_source_evidence_level',
  'source_policy_blocked',
  'stale_source_version',
  'source_already_upgraded_content_changed',
  'source_url_unresolvable',
  'candidate_not_found',
  'candidate_not_active',
  'source_version_not_found',
] as const;
export type EvidenceUpgradeBlockReason = (typeof EVIDENCE_UPGRADE_BLOCK_REASONS)[number];

/** 稳定、机器可读的 FAILED reason code（不变量违规 / 异常碰撞）。 */
export const EVIDENCE_UPGRADE_FAIL_REASONS = [
  'content_hash_collision',
  'version_chain_invariant_violation',
] as const;
export type EvidenceUpgradeFailReason = (typeof EVIDENCE_UPGRADE_FAIL_REASONS)[number];

export type EvidenceUpgradeResult =
  | { status: 'UPGRADED'; versionId: string; snapshotId: string; candidateId: string }
  | { status: 'ALREADY_UPGRADED'; existingVersionId: string; candidateId: string }
  | { status: 'BLOCKED'; reasonCode: EvidenceUpgradeBlockReason }
  | { status: 'FAILED'; reasonCode: EvidenceUpgradeFailReason };
