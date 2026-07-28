/**
 * RC-10 雷达动作 API 协调层（第二波）。
 *
 * 职责：把 HTTP DTO 与 Wave1 领域服务 RadarActionService 拼接，并提供只读视图投影
 * （当前生效态 + append-only 历史）。严格边界与 RadarActionService 一致：
 * - 只写 radar_actions（经 RadarActionService），绝不触碰 jobs/applications/feedback_events；
 * - appliedPending 的 appliedAt 用服务端 now、sourceSnapshotId 由注入的解析器给出，
 *   客户端不可伪造审计锚点；channel / followUpDueAt 允许来自用户输入；
 * - 幂等：apply 已生效 / revert 无生效 均返回 changed=false，不产生新事件。
 */
import type { RadarAction } from '../../../src/domain/radar';
import type { SqliteDatabase } from '../../db';
import { RadarActionRepository } from '../actionRepository';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarActionService, type ActionReason } from './actionService';
import { ACTION_FAMILIES, deriveActionState, type ActionFamily } from './actionState';
import type {
  ActionApplyRequest, ActionFamilyDto, ActionHistoryEntry, ActionResultView,
  ActionRevertRequest, CandidateActionView,
} from './actionDtoSchemas';
import { ACTION_HISTORY_MAX } from './actionDtoSchemas';

export interface RadarActionCoordinatorDeps {
  now: () => number;
  createId: () => string;
  /** 解析候选最近一次快照 id（用于 appliedPending 审计锚点）；无则 null。由路由注入。 */
  resolveLatestSnapshotId: (candidateId: string) => string | null;
}

/** 反查：每种事件类型属于哪一族、是否 set 事件（用于历史投影）。 */
const SET_TYPE_TO_FAMILY = new Map(
  (Object.entries(ACTION_FAMILIES) as [ActionFamily, { set: string; revert: string }][])
    .map(([family, { set }]) => [set, family]),
);
const REVERT_TYPE_TO_FAMILY = new Map(
  (Object.entries(ACTION_FAMILIES) as [ActionFamily, { set: string; revert: string }][])
    .map(([family, { revert }]) => [revert, family]),
);

export class RadarActionCoordinator {
  private readonly service: RadarActionService;
  private readonly actions: RadarActionRepository;
  private readonly candidates: RadarCandidateRepository;

  constructor(
    db: SqliteDatabase,
    private readonly deps: RadarActionCoordinatorDeps,
  ) {
    this.service = new RadarActionService(db, { now: deps.now, createId: deps.createId });
    this.actions = new RadarActionRepository(db);
    this.candidates = new RadarCandidateRepository(db);
  }

  /** 只读：候选四族生效态 + append-only 历史（动作栏八种事件，升序）。 */
  getView(candidateId: string): CandidateActionView {
    const all = this.actions.listByCandidate(candidateId);
    const candidate = this.candidates.getCandidate(candidateId);
    return {
      candidateId,
      activeCandidateVersionId: candidate?.activeVersionId ?? null,
      state: deriveActionState(all),
      history: this.projectHistory(all),
    };
  }

  apply(req: ActionApplyRequest): ActionResultView {
    const family = req.family as ActionFamily;
    const reason = toReason(req.reason);
    const outcome = family === 'appliedPending'
      ? this.service.markAppliedPending(req.candidateId, {
        appliedAt: this.deps.now(),
        followUpDueAt: req.followUpDueAt ?? null,
        sourceSnapshotId: this.deps.resolveLatestSnapshotId(req.candidateId),
        channel: req.channel ?? null,
      }, reason)
      : this.applySet(family, req.candidateId, reason);
    return { changed: outcome.changed, view: this.getView(req.candidateId) };
  }

  revert(req: ActionRevertRequest): ActionResultView {
    const reason = toReason(req.reason);
    const revertFn: Record<ActionFamilyDto, () => { changed: boolean }> = {
      save: () => this.service.unsave(req.candidateId, reason),
      ignore: () => this.service.restore(req.candidateId, reason),
      priority: () => this.service.unmarkPriority(req.candidateId, reason),
      appliedPending: () => this.service.revertAppliedPending(req.candidateId, reason),
    };
    const outcome = revertFn[req.family]();
    return { changed: outcome.changed, view: this.getView(req.candidateId) };
  }

  private applySet(family: ActionFamily, candidateId: string, reason: ActionReason | undefined) {
    if (family === 'save') return this.service.save(candidateId, reason);
    if (family === 'ignore') return this.service.ignore(candidateId, reason);
    return this.service.markPriority(candidateId, reason);
  }

  /** 只投影动作栏八种事件（跳过规则覆盖/重复裁决/晋升），listByCandidate 为 DESC → 反转为升序。 */
  private projectHistory(actions: readonly RadarAction[]): ActionHistoryEntry[] {
    const entries: ActionHistoryEntry[] = [];
    for (const action of actions) {
      const setFamily = SET_TYPE_TO_FAMILY.get(action.actionType);
      const revertFamily = REVERT_TYPE_TO_FAMILY.get(action.actionType);
      const family = setFamily ?? revertFamily;
      if (family === undefined) continue;
      entries.push({
        actionId: action.id,
        actionType: action.actionType as ActionHistoryEntry['actionType'],
        family,
        isSet: setFamily !== undefined,
        reason: action.reasonText,
        candidateVersionId: action.candidateVersionId,
        occurredAt: action.occurredAt,
        reverted: action.revertedByActionId !== null,
      });
    }
    return entries.reverse().slice(0, ACTION_HISTORY_MAX);
  }
}

function toReason(reason: string | null | undefined): ActionReason | undefined {
  const text = reason ?? null;
  return text === null ? undefined : { reasonText: text };
}
