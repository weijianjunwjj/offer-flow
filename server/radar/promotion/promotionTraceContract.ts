/**
 * RC-11 反向追踪领域契约（第一波）。
 *
 * 追踪只呈现**已存储的关联**，缺失或历史数据一律给出明确的不可追溯状态，绝不伪造关联：
 * - 正式对象（Job/Application/FeedbackEvent）→ 引用它的 Promotion（可能多条：link 模式）；
 * - Promotion → Radar 候选版本（FK RESTRICT，历史/损坏数据才可能 missing）；
 * - Promotion → 触发原因：**只存 trigger_action_id**，不存 trigger 枚举，
 *   故触发原因 = 解析该 RadarAction；未记录则 `not_recorded`，绝不臆测枚举；
 * - Promotion → 推荐批次：晋升表**不存 batch_id**，只能按 scope 成员关系推断，
 *   状态显式标注为 `linked_by_scope_membership`，不冒充因果来源。
 */
import type {
  RadarActionType,
  RadarCandidateVersionOriginType,
  RadarPromotionType,
  RadarRecommendationBatchStatus,
  RadarRecommendationDiagnosisStatus,
} from '../../../src/domain/radar';

/** 可反向追踪的正式对象种类。 */
export const FORMAL_OBJECT_KINDS = ['job', 'application', 'feedback_event'] as const;
export type FormalObjectKind = (typeof FORMAL_OBJECT_KINDS)[number];

/** 候选版本解析结果：resolved 附关键快照锚点；missing 只回传 id，不编造内容。 */
export type CandidateVersionTrace =
  | {
    status: 'resolved';
    candidateId: string;
    candidateVersionId: string;
    versionNo: number;
    contentHash: string;
    originType: RadarCandidateVersionOriginType;
    sourceSnapshotIds: string[];
    createdAt: number;
  }
  | { status: 'missing'; candidateVersionId: string };

/** 触发原因追踪：not_recorded（未留痕）/ resolved（解析到 RadarAction）/ action_missing（留痕但行丢失）。 */
export type TriggerTrace =
  | { status: 'not_recorded' }
  | {
    status: 'resolved';
    actionId: string;
    actionType: RadarActionType;
    reasonCode: string | null;
    reasonText: string | null;
    occurredAt: number;
    /** 该触发动作事后是否被撤销——撤销为 append-only，不影响正式事实链路，仅如实标注。 */
    reverted: boolean;
    revertedByActionId: string | null;
  }
  | { status: 'action_missing'; triggerActionId: string };

/** 批次成员引用：wasSelected 区分"进入建议"与"仅在 scope 内被覆盖"。 */
export interface BatchMembershipRef {
  batchId: string;
  batchKey: string;
  status: RadarRecommendationBatchStatus;
  diagnosisStatus: RadarRecommendationDiagnosisStatus;
  emptyReason: string | null;
  generatedAt: number;
  /** 候选版本是否进入该批次的最终建议（在 selected 内）；否则仅被 scope 覆盖。 */
  wasSelected: boolean;
}

/**
 * 推荐批次追踪：显式声明这是**成员关系推断**而非因果外键。
 * linked_by_scope_membership = 至少一个批次 scope 覆盖过该候选版本；no_batch = 无。
 */
export type RecommendationBatchTrace =
  | { status: 'linked_by_scope_membership'; batches: BatchMembershipRef[] }
  | { status: 'no_batch' };

/** 单条晋升的来源追踪：候选版本 + 触发原因 + 推荐批次（三者各自带状态）。 */
export interface PromotionOriginTrace {
  promotionId: string;
  promotionType: RadarPromotionType;
  candidateId: string;
  jobId: string;
  applicationId: string | null;
  feedbackEventId: string | null;
  createdAt: number;
  candidateVersion: CandidateVersionTrace;
  trigger: TriggerTrace;
  recommendationBatches: RecommendationBatchTrace;
}

/**
 * 正式对象 → 来源的反向追踪结果。
 * traceable=false + reason=no_promotion：无任何晋升引用该对象（如 Radar 之外创建 / 历史数据），
 * 明确不可追溯，不编造来源。
 */
export type FormalObjectTrace =
  | { objectKind: FormalObjectKind; objectId: string; traceable: true; promotions: PromotionOriginTrace[] }
  | { objectKind: FormalObjectKind; objectId: string; traceable: false; reason: 'no_promotion' };
