/**
 * V8-3 commit 决策引擎（纯函数，无 DB / 无副作用）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §4/§6/§8。
 *
 * 输入：已解析的 identity 决策 + 旧 active 版本的 normalized（可空）+ 新 normalized + 标准化产出的
 * ambiguous 字段；输出：结构化 CommitDecisionSummary（decisionType + changedFields + 资格/确认/冲突）。
 *
 * 该模块只做确定性判定，不写库；落库由 service.ts 的事务协调器按 decisionType 执行。
 */

import type { RadarCandidateNormalized, RadarEvidenceLevel } from '../../src/domain/radar';
import type { IdentityDecision } from './identityResolution';
import { classifyMaterialChange, type FieldChange } from './materialChange';
import {
  CHANGE_SET_CONTRACT_VERSION,
  type CommitDecisionSummary,
  type CommitDecisionType,
  type FieldChangeEntry,
  type FieldChangeClassification,
} from './candidateChangeSet';

// ── Data Quality Gate（v0.9 Phase 4A: T034/T036）───────────────────────────────

/**
 * 判断给定 evidenceLevel 是否允许进入 MatchAnalysis。
 *
 *   只有 FULL_EVIDENCE 才返回 true。
 *   SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 返回 false。
 *
 * 这是 decideCommit 内部 evidence gate 的唯一可信源——decideCommit 复用此函数，
 * 不在内部建立第二套可漂移的判定。
 */
export function canEnterAnalysis(evidenceLevel: RadarEvidenceLevel): boolean {
  return evidenceLevel === 'FULL_EVIDENCE';
}

/**
 * 返回给定 evidenceLevel 的分析阻断原因（可读字符串）。
 *
 *   FULL_EVIDENCE → null（无阻断）
 *   SEARCH_EVIDENCE → insufficient_evidence 原因
 *   MANUAL_REVIEW_REQUIRED → manual_review_required 原因
 */
export function evidenceGateReason(evidenceLevel: RadarEvidenceLevel): string | null {
  switch (evidenceLevel) {
    case 'FULL_EVIDENCE':
      return null;
    case 'SEARCH_EVIDENCE':
      return 'insufficient_evidence: SEARCH_EVIDENCE cannot enter MatchAnalysis — full job facts not yet acquired';
    case 'MANUAL_REVIEW_REQUIRED':
      return 'manual_review_required: user must confirm before analysis — source policy prohibits auto-fetch';
  }
}

// ── CommitDecision types ────────────────────────────────────────────────────────

export interface CommitDecisionInput {
  identity: IdentityDecision;
  /** 已有 active 版本的 normalized（identity=exact_existing 且有 active 版本时非 null）。 */
  previousNormalized: RadarCandidateNormalized | null;
  /** 本次标准化产出的 normalized 事实。 */
  nextNormalized: RadarCandidateNormalized;
  /** 标准化阶段判定为 ambiguous、需人工确认的字段。 */
  ambiguousFields: string[];
  /** 本次快照 ID，用于 changedFields 溯源。 */
  snapshotId: string;
  /**
   * v0.9：证据等级。
   *   canEnterAnalysis() 是唯一 gate 源；decideCommit 复用该函数。
   *   未提供时默认 FULL_EVIDENCE（Browser Capture 兼容）。
   */
  evidenceLevel?: RadarEvidenceLevel;
}

export interface CommitDecision {
  summary: CommitDecisionSummary;
  /** 供 service 落库使用的 fingerprint（下一版本 content_hash）。 */
  fingerprint: string;
}

/** materialChange 的字段变化 kind → changedFields 契约分类。 */
function toClassification(kind: FieldChange['kind']): FieldChangeClassification {
  switch (kind) {
    case 'unknown_to_known': return 'added_fact';
    case 'known_to_unknown': return 'extraction_regression';
    case 'value_changed': return 'changed_fact';
  }
}

/** JSON-safe 化 before/after：数组/标量原样，其余转 null（受限值契约在落库前再校验）。 */
function jsonSafe(value: unknown): FieldChangeEntry['before'] {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return null;
}

function toEntries(changes: FieldChange[], snapshotId: string): FieldChangeEntry[] {
  return changes.map((c) => ({
    fieldPath: c.field,
    before: jsonSafe(c.before),
    after: jsonSafe(c.after),
    classification: toClassification(c.kind),
    reason: `${c.field} ${c.kind}`,
    sourceSnapshotId: snapshotId,
    confidence: null,
  }));
}

/**
 * 计算 commit 决策。决策优先级：
 *   0) evidenceLevel gate（最高优先——在任何 analysisEligible=true 之前先检查）：
 *      复用 canEnterAnalysis() 作为唯一 gate 源；
 *      SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED → analysisEligible = false
 *      FULL_EVIDENCE（默认）→ 走原 v0.8 逻辑
 *   1) identity_conflict > ambiguous_change > (材料变化分类)
 */
export function decideCommit(input: CommitDecisionInput): CommitDecision {
  const material = classifyMaterialChange(input.previousNormalized, input.nextNormalized);
  const fingerprint = material.fingerprint;

  // 0) evidenceLevel gate — SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED 绝不能进入分析。
  //    复用 canEnterAnalysis() 作为唯一 gate 源，避免与外部调用形成两套可漂移逻辑。
  const effectiveLevel = input.evidenceLevel ?? 'FULL_EVIDENCE';
  const evidenceGateBlocks = !canEnterAnalysis(effectiveLevel);

  // 1) 身份冲突最高优先：不建候选、不建版本、阻断分析。
  if (input.identity.kind === 'identity_conflict') {
    return {
      fingerprint,
      summary: {
        contractVersion: CHANGE_SET_CONTRACT_VERSION,
        decisionType: 'identity_conflict',
        changedFields: [],
        analysisEligible: false,
        needsConfirmation: [],
        blockingIssues: [`identity_conflict: ${input.identity.reason}`],
        conflictReason: input.identity.reason,
      },
    };
  }

  // 2) 新身份：建候选 + 首版。analysisEligible 受 evidenceLevel gate 控制。
  if (input.identity.kind === 'new_source' || input.previousNormalized === null) {
    return {
      fingerprint,
      summary: summary('new_identity', [], !evidenceGateBlocks, input.ambiguousFields),
    };
  }

  // 3) 已有身份：按材料变化分类。
  const entries = toEntries(material.changedFields, input.snapshotId);

  // 标准化报告 ambiguous（冲突值/字段串位等）优先于其余判定：进人工确认，绝不静默建版本或静默退化。
  if (input.ambiguousFields.length > 0) {
    return { fingerprint, summary: summary('ambiguous_change', entries, false, input.ambiguousFields) };
  }

  if (material.classification === 'no_change') {
    return { fingerprint, summary: summary('no_change', [], false, []) };
  }

  if (material.classification === 'extraction_regression') {
    return {
      fingerprint,
      summary: {
        contractVersion: CHANGE_SET_CONTRACT_VERSION,
        decisionType: 'extraction_regression',
        changedFields: entries,
        analysisEligible: false,
        needsConfirmation: entries.map((e) => e.fieldPath),
        blockingIssues: [],
        conflictReason: null,
      },
    };
  }

  // material_change：ambiguous 已在前面拦截，此处为确定的实质变化。
  // analysisEligible 受 evidenceLevel gate 控制。
  return { fingerprint, summary: summary('material_change', entries, !evidenceGateBlocks, []) };
}

function summary(
  decisionType: CommitDecisionType,
  changedFields: FieldChangeEntry[],
  analysisEligible: boolean,
  needsConfirmation: string[],
): CommitDecisionSummary {
  return {
    contractVersion: CHANGE_SET_CONTRACT_VERSION,
    decisionType,
    changedFields,
    analysisEligible,
    needsConfirmation,
    blockingIssues: [],
    conflictReason: null,
  };
}
