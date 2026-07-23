/**
 * V8-3 疑似重复关系与人工裁决（Wave 4）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §5/§14b。
 *
 * 严格边界：
 * - 疑似重复只标记，绝不自动合并；人工确认前两个候选保持独立；
 * - confirmed_distinct 持久化后，同一批旧信号不再重复提示；
 * - 仅新实质证据可进入 needs_recheck（新 material 版本 / 公司 unknown→确定且一致 /
 *   新稳定来源关联 / external identity 纠正 / 用户主动撤销）；
 * - 不因 capturedAt / 招聘者活跃度 / confidence / extraction quality 重新提示；
 * - confirmed_same 本阶段只持久化裁决与审计，不执行任何不可逆 Candidate 合并。
 */
import type {
  RadarAction,
  RadarActionType,
  RadarCandidateRelation,
} from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import { RadarActionRepository } from './actionRepository';
import { RadarCandidateRelationRepository, normalizeCandidatePair } from './candidateRelationRepository';
import { radarRelationNotFound, radarRelationRecheckNotAllowed, radarSameCandidateRelation } from './errors';

export interface DuplicateAdjudicationDeps {
  now: () => number;
  createId: () => string;
}

/** 允许 confirmed_distinct → needs_recheck 的新实质证据类型（§5）。 */
export const RECHECK_EVIDENCE_REASONS = [
  'new_material_version',
  'company_resolved_consistent',
  'new_stable_source_link',
  'external_identity_corrected',
  'user_reverted_decision',
] as const;
export type RecheckEvidenceReason = (typeof RECHECK_EVIDENCE_REASONS)[number];

export class RadarDuplicateAdjudicationService {
  private readonly relations: RadarCandidateRelationRepository;
  private readonly actions: RadarActionRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: DuplicateAdjudicationDeps,
  ) {
    this.relations = new RadarCandidateRelationRepository(db);
    this.actions = new RadarActionRepository(db);
  }

  /**
   * 登记一对疑似重复候选（保守信号，只标记不合并）。
   * 幂等：同一候选对已存在关系时——
   * - confirmed_distinct：不重新提示（只刷新检测时间，返回原关系）；
   * - 其它状态：刷新检测时间，返回原关系。
   * 从不创建重复关系行（UNIQUE(low, high) 兜底）。
   */
  registerSuspectedDuplicate(
    candidateA: string,
    candidateB: string,
    signals: unknown,
    reasonCode: string | null,
  ): RadarCandidateRelation {
    if (candidateA === candidateB) throw radarSameCandidateRelation();
    return this.db.transaction(() => {
      const { low, high } = normalizeCandidatePair(candidateA, candidateB);
      const now = this.deps.now();
      const existing = this.relations.findByPair(low, high);
      if (existing !== null) {
        // 已判定非重复：绝不因同一批旧信号重新提示，仅刷新检测时间。
        this.relations.touchDetected(existing.id, now, now);
        return { ...existing, lastDetectedAt: now, updatedAt: now };
      }
      const relation: RadarCandidateRelation = {
        id: this.deps.createId(),
        candidateIdLow: low,
        candidateIdHigh: high,
        status: 'suspected_duplicate',
        reasonCode,
        signals: signals ?? null,
        firstDetectedAt: now,
        lastDetectedAt: now,
        resolvedAt: null,
        resolutionActionId: null,
        supersededByRelationId: null,
        createdAt: now,
        updatedAt: now,
      };
      this.relations.insert(relation);
      return relation;
    })();
  }

  /** 人工确认"是同一岗位"：状态置 confirmed_same + 追加 duplicate_confirmed 审计（不执行不可逆合并）。 */
  confirmSame(relationId: string, actorReason: string | null): RadarCandidateRelation {
    return this.resolve(relationId, 'confirmed_same', 'duplicate_confirmed', actorReason);
  }

  /** 人工确认"不是重复"：状态置 confirmed_distinct + 追加 duplicate_rejected 审计（防反复提示）。 */
  confirmDistinct(relationId: string, actorReason: string | null): RadarCandidateRelation {
    return this.resolve(relationId, 'confirmed_distinct', 'duplicate_rejected', actorReason);
  }

  /** 撤销上一次裁决：回到 suspected_duplicate + 追加 duplicate_decision_reverted 审计。 */
  revertDecision(relationId: string, actorReason: string | null): RadarCandidateRelation {
    return this.resolve(relationId, 'suspected_duplicate', 'duplicate_decision_reverted', actorReason);
  }

  /**
   * 因新实质证据请求复审：仅当 evidenceReason 属于允许集合时，
   * confirmed_distinct/confirmed_same → needs_recheck + 追加 duplicate_recheck_requested 审计。
   * 不因采集时间/活跃度/置信度等非实质变化重新提示。
   */
  requestRecheck(
    relationId: string,
    evidenceReason: RecheckEvidenceReason,
    detail: string | null,
  ): RadarCandidateRelation {
    if (!RECHECK_EVIDENCE_REASONS.includes(evidenceReason)) {
      throw radarRelationRecheckNotAllowed(String(evidenceReason));
    }
    return this.db.transaction(() => {
      const relation = this.relations.getById(relationId);
      if (relation === null) throw radarRelationNotFound();
      const now = this.deps.now();
      const action = this.appendAction(
        relation,
        'duplicate_recheck_requested',
        detail,
        { evidenceReason, previousStatus: relation.status },
        now,
      );
      this.relations.updateStatus(relationId, 'needs_recheck', null, action.id, now, relation.reasonCode);
      return { ...relation, status: 'needs_recheck' as const, resolutionActionId: action.id, updatedAt: now };
    })();
  }

  private resolve(
    relationId: string,
    status: RadarCandidateRelation['status'],
    actionType: RadarActionType,
    actorReason: string | null,
  ): RadarCandidateRelation {
    return this.db.transaction(() => {
      const relation = this.relations.getById(relationId);
      if (relation === null) throw radarRelationNotFound();
      const now = this.deps.now();
      const resolvedAt = status === 'suspected_duplicate' ? null : now;
      const action = this.appendAction(relation, actionType, actorReason, { previousStatus: relation.status }, now);
      this.relations.updateStatus(relationId, status, resolvedAt, action.id, now, relation.reasonCode);
      return { ...relation, status, resolvedAt, resolutionActionId: action.id, updatedAt: now };
    })();
  }

  /**
   * 追加式审计事件。关系裁决绑定到 candidateIdLow 的当前 active 版本作为审计锚点；
   * 关系另一侧候选与信号存入 metadata。绝不删除或改写旧事件。
   */
  private appendAction(
    relation: RadarCandidateRelation,
    actionType: RadarActionType,
    reasonText: string | null,
    extraMetadata: Record<string, unknown>,
    now: number,
  ): RadarAction {
    const anchor = this.resolveAnchorVersion(relation.candidateIdLow);
    const action: RadarAction = {
      id: this.deps.createId(),
      candidateId: relation.candidateIdLow,
      candidateVersionId: anchor,
      actionType,
      reasonCode: relation.reasonCode,
      reasonText,
      metadata: {
        relationId: relation.id,
        counterpartCandidateId: relation.candidateIdHigh,
        ...extraMetadata,
      },
      occurredAt: now,
      revertedByActionId: null,
      createdAt: now,
    };
    this.actions.insert(action);
    return action;
  }

  /** 取候选当前 active 版本作为审计锚点（radar_actions.candidate_version_id NOT NULL）。 */
  private resolveAnchorVersion(candidateId: string): string {
    const row = this.db
      .prepare('SELECT active_version_id FROM radar_candidates WHERE id = ?')
      .get(candidateId) as { active_version_id: string | null } | undefined;
    if (row?.active_version_id == null) {
      throw radarRelationNotFound();
    }
    return row.active_version_id;
  }
}
