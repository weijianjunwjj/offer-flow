/**
 * v0.9 P0.1 — Evidence-state content hash（同材料 + 不同证据状态的版本身份）。
 *
 * 背景：材料指纹 `computeCandidateFingerprint`（prefix `radar-candidate-version:v1`）
 * 刻意排除 evidenceLevel。配合 `UNIQUE(candidate_id, content_hash)`，导致：
 *   「相同材料内容 + 当前 SourcePolicy 要求的新证据状态」无法创建独立版本，
 *   historical reactivation 只能把 active 退回到旧 evidenceLevel 版本（证据倒退）。
 *
 * 本模块为 daily discovery 版本引入 evidence-aware content hash（独立 hash 空间）：
 *   输入 = { materialFingerprint, evidenceLevel }
 *   同材料 + 同证据 → 稳定（可 reactivation）
 *   同材料 + 不同证据 → 不同 hash（可创建 evidence-state 版本，互不冲突）
 *   不同材料 → 不同 hash（material identity 仍由材料指纹保证）
 *
 * 材料指纹 v1 契约不变（material-change 检测仍用它）；EvidenceUpgradeService
 * 的 `evidence-upgrade-content:v1` hash 空间也不变。
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../job-memory/requestHash';
import type { RadarCandidateNormalized, RadarEvidenceLevel } from '../../src/domain/radar';
import { computeCandidateFingerprint } from './candidateFingerprint';

/** 参与哈希，隔离算法升级；与材料指纹 / evidence-upgrade hash 不同源。 */
export const EVIDENCE_STATE_CONTENT_HASH_PREFIX = 'radar-candidate-evidence:v1';

/**
 * sha256('radar-candidate-evidence:v1\n' + canonicalJson({ materialFingerprint, evidenceLevel }))。
 * canonicalJson 递归按 key 排序，输入稳定。
 */
export function computeEvidenceStateContentHash(
  normalized: RadarCandidateNormalized,
  evidenceLevel: RadarEvidenceLevel,
): string {
  const materialFingerprint = computeCandidateFingerprint(normalized);
  const input = `${EVIDENCE_STATE_CONTENT_HASH_PREFIX}\n${canonicalJson({ materialFingerprint, evidenceLevel })}`;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 证据状态可信度序（仅用于「同材料 + 证据状态变化」时的单调性判断）：
 *   MANUAL_REVIEW_REQUIRED(1) < SEARCH_EVIDENCE(2) < FULL_EVIDENCE(3)
 * 规则：材料未变化时，只允许证据状态提升，不允许无理由降级（如 FULL→SEARCH）。
 * 材料真正变化不适用本序（material_change 始终创建新版本，evidence 按当前 policy）。
 */
export function evidenceRank(level: RadarEvidenceLevel): number {
  const rank: Record<RadarEvidenceLevel, number> = {
    MANUAL_REVIEW_REQUIRED: 1,
    SEARCH_EVIDENCE: 2,
    FULL_EVIDENCE: 3,
  };
  return rank[level];
}
