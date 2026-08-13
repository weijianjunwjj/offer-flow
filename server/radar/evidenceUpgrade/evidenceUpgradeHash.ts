/**
 * v0.9 Phase 5A — Evidence Upgrade 内容哈希。
 *
 * 与 material fingerprint（computeCandidateFingerprint）刻意分离：
 *   - material fingerprint 表示「材料是否实质变化」，排除 rawDescription；
 *   - evidence upgrade content hash 表示「完整升级后内容的字节指纹」，包含 rawDescription。
 *
 * 当 rawDescription 从搜索摘要升级为完整正文时，material fingerprint 可保持不变，
 * 但 upgrade content hash 必须变化。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../job-memory/requestHash';
import type { RadarCandidateNormalized } from '../../../src/domain/radar';

/** 前缀参与哈希，隔离算法升级；与 FINGERPRINT_PREFIX 不同源。 */
export const EVIDENCE_UPGRADE_CONTENT_HASH_PREFIX = 'evidence-upgrade-content:v1';

/**
 * sha256('evidence-upgrade-content:v1\n' + canonicalJson(upgradedNormalized))。
 * 输入为完整 RadarCandidateNormalized（含 rawDescription），复用 canonicalJson，
 * 不另造 canonicalization。
 */
export function computeEvidenceUpgradeContentHash(upgradedNormalized: RadarCandidateNormalized): string {
  const input = `${EVIDENCE_UPGRADE_CONTENT_HASH_PREFIX}\n${canonicalJson(upgradedNormalized)}`;
  return createHash('sha256').update(input).digest('hex');
}
