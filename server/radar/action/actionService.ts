/**
 * RC-10 雷达动作领域核心（第一波）。
 *
 * 设计依据：PRD §4.9/§9.5/P0-10、TD §4.11、INV-04/INV-06、release-contract RC-10/RC-11。
 *
 * 严格边界：
 * - 处理状态只以 append-only RadarAction 流水表达，绝不在 Candidate 上存混合处理状态、
 *   绝不新建影子 Application 表（RC-10 不通过条件）；
 * - 每条动作绑定候选当前 active 版本作为审计锚点（INV-04）；
 * - apply 幂等：已生效不重复插入事件；revert 幂等：无生效 set 时不产生事件；
 * - revert 只回填被撤销事件的 reverted_by_action_id（追加 *_reverted / unsaved 事件），
 *   只改 Radar 决策状态；本服务只写 radar_actions 一张表，绝不触碰
 *   jobs / applications / feedback_events（撤销不删除或篡改已晋升正式事实，RC-11）；
 * - marked_applied_pending 与其撤销都不产生拒绝、负向 CandidateEvidence 或画像降级（INV-06）。
 */
import type { RadarAction } from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { RadarActionRepository } from '../actionRepository';
import { RadarCandidateRepository } from '../candidateRepository';
import { ACTION_FAMILIES, activeSetAction, deriveActionState, type ActionFamily, type RadarActionState } from './actionState';
import { candidateHasNoActiveVersion, candidateNotFound } from './actionErrors';

export interface RadarActionServiceDeps {
  now: () => number;
  createId: () => string;
}

/** 可选的动作原因留痕（稳定码 + 自由文本），仅用于审计，不影响状态判定。 */
export interface ActionReason {
  reasonCode?: string | null;
  reasonText?: string | null;
}

/** metadata for marked_applied_pending（TD §4.11）；无回复语义，绝不衍生负反馈。 */
export interface AppliedPendingMeta {
  appliedAt: number;
  followUpDueAt: number | null;
  sourceSnapshotId: string | null;
  channel: string | null;
}

export interface ActionOutcome {
  /** 本次真正写入的事件；幂等 no-op 时为 null。 */
  action: RadarAction | null;
  /** 相对调用前是否发生状态变化。 */
  changed: boolean;
  /** 操作后该候选四族当前生效态。 */
  state: RadarActionState;
}

export class RadarActionService {
  private readonly actions: RadarActionRepository;
  private readonly candidates: RadarCandidateRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: RadarActionServiceDeps,
  ) {
    this.actions = new RadarActionRepository(db);
    this.candidates = new RadarCandidateRepository(db);
  }

  save(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applySet(candidateId, 'save', reason, null);
  }

  unsave(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applyRevert(candidateId, 'save', reason);
  }

  ignore(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applySet(candidateId, 'ignore', reason, null);
  }

  restore(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applyRevert(candidateId, 'ignore', reason);
  }

  markPriority(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applySet(candidateId, 'priority', reason, null);
  }

  unmarkPriority(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applyRevert(candidateId, 'priority', reason);
  }

  /**
   * 标记「已投递待反馈」——纯用户事实，不创建 Application、不产生任何正式负反馈（INV-06）。
   * metadata 记录 appliedAt / followUpDueAt / sourceSnapshotId / channel（TD §4.11）。
   */
  markAppliedPending(candidateId: string, meta: AppliedPendingMeta, reason?: ActionReason): ActionOutcome {
    return this.applySet(candidateId, 'appliedPending', reason, { ...meta });
  }

  /** 撤销「已投递待反馈」——只撤销 Radar 决策状态；绝不衍生拒绝 / 负向 CandidateEvidence（INV-06）。 */
  revertAppliedPending(candidateId: string, reason?: ActionReason): ActionOutcome {
    return this.applyRevert(candidateId, 'appliedPending', reason);
  }

  /** 读取某候选四族当前生效态（纯读，事件流投影）。 */
  getState(candidateId: string): RadarActionState {
    return deriveActionState(this.actions.listByCandidate(candidateId));
  }

  /** 置位某动作族。已生效 → 幂等 no-op（不重复插入事件）。 */
  private applySet(
    candidateId: string,
    family: ActionFamily,
    reason: ActionReason | undefined,
    extraMetadata: Record<string, unknown> | null,
  ): ActionOutcome {
    return this.db.transaction(() => {
      const anchor = this.resolveActiveVersion(candidateId);
      const existing = this.actions.listByCandidate(candidateId);
      if (activeSetAction(existing, family) !== null) {
        return { action: null, changed: false, state: deriveActionState(existing) };
      }
      const action = this.append(candidateId, anchor, ACTION_FAMILIES[family].set, reason, extraMetadata);
      return { action, changed: true, state: deriveActionState([...existing, action]) };
    })();
  }

  /**
   * 撤销某动作族的当前生效 set。无生效 set → 幂等 no-op。
   * 追加 *_reverted / unsaved 事件并回填被撤销事件的 reverted_by_action_id；只改 Radar 决策状态。
   */
  private applyRevert(candidateId: string, family: ActionFamily, reason: ActionReason | undefined): ActionOutcome {
    return this.db.transaction(() => {
      const existing = this.actions.listByCandidate(candidateId);
      const target = activeSetAction(existing, family);
      if (target === null) {
        // 无生效状态可撤销：不写事件、不触碰任何正式事实。
        this.resolveActiveVersion(candidateId);
        return { action: null, changed: false, state: deriveActionState(existing) };
      }
      // 撤销事件锚定到被撤销 set 的同一版本，保持审计一致。
      const revert = this.append(candidateId, target.candidateVersionId, ACTION_FAMILIES[family].revert, reason, {
        revertsActionId: target.id,
      });
      this.actions.markReverted(target.id, revert.id);
      const reverted = { ...target, revertedByActionId: revert.id };
      const next = existing.map((a) => (a.id === target.id ? reverted : a)).concat(revert);
      return { action: revert, changed: true, state: deriveActionState(next) };
    })();
  }

  private append(
    candidateId: string,
    candidateVersionId: string,
    actionType: RadarAction['actionType'],
    reason: ActionReason | undefined,
    extraMetadata: Record<string, unknown> | null,
  ): RadarAction {
    const now = this.deps.now();
    const action: RadarAction = {
      id: this.deps.createId(),
      candidateId,
      candidateVersionId,
      actionType,
      reasonCode: reason?.reasonCode ?? null,
      reasonText: reason?.reasonText ?? null,
      metadata: extraMetadata ?? {},
      occurredAt: now,
      revertedByActionId: null,
      createdAt: now,
    };
    this.actions.insert(action);
    return action;
  }

  /** 候选当前 active 版本（radar_actions.candidate_version_id NOT NULL 的审计锚点）。 */
  private resolveActiveVersion(candidateId: string): string {
    const candidate = this.candidates.getCandidate(candidateId);
    if (candidate === null) throw candidateNotFound();
    if (candidate.activeVersionId === null) throw candidateHasNoActiveVersion();
    return candidate.activeVersionId;
  }
}
