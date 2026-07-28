/**
 * RC-10 雷达动作 API（第二波）的严格 DTO 契约。
 *
 * 设计依据：TD §4.11、INV-04/INV-06、release-contract RC-10/RC-11，与 reviewDtoSchemas 同风格。
 *
 * 严格边界：
 * - 只接受动作栏四族（save/ignore/priority/appliedPending）；规则覆盖、重复裁决、
 *   promotion_requested 不经此 API（各有专用受控入口），避免旁路正式事实；
 * - 服务端 Envelope 负责 ID/版本/时间戳；客户端不得自带 actionId / candidateVersionId /
 *   appliedAt / sourceSnapshotId（appliedAt 由服务端 now、快照由服务端解析，防伪造审计锚点）；
 * - reason 可选但限长（动作栏是一键切换，不像关系裁决强制填原因）。
 */
import { z } from 'zod';

export const ACTION_REASON_MAX = 500;
export const ACTION_HISTORY_MAX = 100;

/** 动作栏四族：与 actionState.ACTION_FAMILIES 键对齐。 */
export const ACTION_FAMILIES_DTO = ['save', 'ignore', 'priority', 'appliedPending'] as const;
export const ActionFamilySchema = z.enum(ACTION_FAMILIES_DTO);
export type ActionFamilyDto = z.infer<typeof ActionFamilySchema>;

const reason = z.string().trim().min(1).max(ACTION_REASON_MAX).nullable().optional();

/**
 * 执行/撤销动作请求。appliedPending 可带渠道与跟进到期（纯用户事实，绝不衍生投递/负反馈）；
 * appliedAt 与 sourceSnapshotId 一律由服务端补齐，客户端不可提供。
 */
export const ActionApplyRequestSchema = z.strictObject({
  candidateId: z.string().trim().min(1).max(100),
  family: ActionFamilySchema,
  reason,
  /** 仅 appliedPending 生效：投递渠道（自由文本，限长）。 */
  channel: z.string().trim().min(1).max(60).nullable().optional(),
  /** 仅 appliedPending 生效：跟进到期时间（epoch ms）；无则 null。 */
  followUpDueAt: z.number().int().nonnegative().nullable().optional(),
});
export type ActionApplyRequest = z.infer<typeof ActionApplyRequestSchema>;

export const ActionRevertRequestSchema = z.strictObject({
  candidateId: z.string().trim().min(1).max(100),
  family: ActionFamilySchema,
  reason,
});
export type ActionRevertRequest = z.infer<typeof ActionRevertRequestSchema>;

/* ---------- 响应 DTO ---------- */

/** 四族当前生效态（纯事件流投影）。 */
export const ActionStateViewSchema = z.strictObject({
  saved: z.boolean(),
  ignored: z.boolean(),
  priority: z.boolean(),
  appliedPending: z.boolean(),
});
export type ActionStateView = z.infer<typeof ActionStateViewSchema>;

/** 动作栏涉及的八种事件类型（不含规则覆盖/重复裁决/晋升）。 */
export const ACTION_BAR_ACTION_TYPES = [
  'saved', 'unsaved',
  'ignored', 'ignore_reverted',
  'marked_priority', 'priority_reverted',
  'marked_applied_pending', 'applied_pending_reverted',
] as const;

/** append-only 历史条目（只读聚合，绝不改写旧事件）。 */
export const ActionHistoryEntrySchema = z.strictObject({
  actionId: z.string(),
  actionType: z.enum(ACTION_BAR_ACTION_TYPES),
  family: ActionFamilySchema,
  /** set 事件为 true，*_reverted / unsaved 为 false。 */
  isSet: z.boolean(),
  reason: z.string().nullable(),
  candidateVersionId: z.string(),
  occurredAt: z.number(),
  /** 该 set 事件是否已被后续撤销事件回填。 */
  reverted: z.boolean(),
});
export type ActionHistoryEntry = z.infer<typeof ActionHistoryEntrySchema>;

/** 候选动作视图：当前生效态 + append-only 历史（升序，旧→新）。 */
export const CandidateActionViewSchema = z.strictObject({
  candidateId: z.string(),
  activeCandidateVersionId: z.string().nullable(),
  state: ActionStateViewSchema,
  history: z.array(ActionHistoryEntrySchema).max(ACTION_HISTORY_MAX),
});
export type CandidateActionView = z.infer<typeof CandidateActionViewSchema>;

/** 执行/撤销结果：是否真正变更（幂等 no-op 时 false）+ 变更后完整视图。 */
export const ActionResultViewSchema = z.strictObject({
  changed: z.boolean(),
  view: CandidateActionViewSchema,
});
export type ActionResultView = z.infer<typeof ActionResultViewSchema>;
