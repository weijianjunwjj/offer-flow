import type {
  ApplicationChannel,
  ApplicationRecord,
  FeedbackEventRecord,
  SourceConfidence,
} from '../job-memory';
import type { JobRecord } from '../../storage/types';
import type { JobFamilyId } from './jobFamily';

export const FUNNEL_TIME_GRANULARITIES = ['none', 'month', 'quarter'] as const;
export type FunnelTimeGranularity = (typeof FUNNEL_TIME_GRANULARITIES)[number];

/** 分组维度：一次只能选择一个维度；筛选（FunnelQuery 的其余字段）与分组维度互相独立。 */
export const FUNNEL_GROUP_DIMENSIONS = ['none', 'city', 'jobFamily', 'channel', 'resumeVersion'] as const;
export type FunnelGroupDimension = (typeof FUNNEL_GROUP_DIMENSIONS)[number];

export interface FunnelQuery {
  city?: string | null;
  jobFamily?: JobFamilyId | null;
  channel?: ApplicationChannel | null;
  resumeVersionId?: string | null;
  /** 半开区间 [from, to)，按 Application.createdAt 过滤；均为毫秒时间戳。 */
  from?: number | null;
  to?: number | null;
  timeGranularity?: FunnelTimeGranularity;
  groupBy?: FunnelGroupDimension;
}

/**
 * 漏斗阶段：按业务上不可逆的推进顺序排列。阶段的"曾达到"统计是单调的——
 * 一个流程只要曾经产生过某一阶段（或更高阶段）对应的事件，即视为到达该阶段
 * 及其之前所有阶段，不受后续暂停、关闭或拒绝影响。
 *
 * "索要简历"与"电话沟通"是否自动补齐：本模型采用统一裁决——若流程后续曾达到
 * 面试安排及以上阶段，则视为索要简历与电话沟通两个阶段均已到达（即使实际历史
 * 事件中只记录了其中一种或都未单独记录），因为面试安排在业务上必然意味着已经
 * 经过某种形式的简历筛选/电话沟通。这是唯一自动补齐规则，不额外推断其它阶段。
 */
export const FUNNEL_STAGES = [
  'applied',
  'valid_reply',
  'resume_requested',
  'phone_screen',
  'interview_scheduled',
  'interview_completed',
  'interview_advanced',
  'offer_received',
  'offer_accepted',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStage, string> = {
  applied: '已投递',
  valid_reply: '有效回复',
  resume_requested: '索要简历',
  phone_screen: '电话沟通',
  interview_scheduled: '面试安排',
  interview_completed: '面试完成',
  interview_advanced: '面试推进',
  offer_received: 'Offer 收到',
  offer_accepted: 'Offer 接受',
};

export interface FunnelStageCount {
  stage: FunnelStage;
  count: number;
  /** 相对上一阶段的转化率；第一阶段（applied）为 null，前端显示"起点"。分母为 0 时为 null，前端显示"—"。 */
  conversionFromPrevious: number | null;
  /** 相对"已投递"总数的转化率；第一阶段固定为 1（100%）。分母为 0 时为 null。 */
  conversionFromApplied: number | null;
}

/**
 * 流程终态/当前状态分布。规则集中定义在 aggregate.ts 的 deriveProcessStatus 中：
 * - no_response_recorded 或 marked_stale 之后没有恢复/推进事件 → stale，不计入拒绝；
 * - recruitment_paused/frozen 之后没有 process_resumed → paused_frozen，不计入拒绝或进行中；
 * - process_resumed 或任何更晚的有效推进事件会覆盖上述两种状态；
 * - rejected / user_withdrew（含 offer_declined）/ position_closed / offer_accepted 分别单独计数；
 * - 其余情况计入 in_progress。
 */
export const FUNNEL_PROCESS_STATUSES = [
  'in_progress',
  'stale',
  'paused_frozen',
  'rejected_by_recruiter',
  'user_withdrew',
  'position_closed',
  'offer_accepted',
] as const;
export type FunnelProcessStatus = (typeof FUNNEL_PROCESS_STATUSES)[number];

export const FUNNEL_PROCESS_STATUS_LABELS: Record<FunnelProcessStatus, string> = {
  in_progress: '进行中',
  stale: '沉默 / 停滞',
  paused_frozen: '招聘暂停 / 冻结',
  rejected_by_recruiter: '招聘方拒绝',
  user_withdrew: '用户退出',
  position_closed: '岗位关闭',
  offer_accepted: 'Offer 接受完成',
};

export type FunnelProcessStatusCounts = Record<FunnelProcessStatus, number>;

/**
 * 流程级数据可信度分级，来自该流程 application_created 事件（正式投递事实的founding record）
 * 的 sourceConfidence + timePrecision 组合，集中定义于 aggregate.ts 的 deriveConfidenceTier：
 * - exact：sourceConfidence=exact 且 timePrecision=exact；
 * - date_level：sourceConfidence=exact 但 timePrecision=date（时间只精确到日期）；
 * - approximate：sourceConfidence=approximate；
 * - recalled：sourceConfidence=recalled；
 * - inferred：sourceConfidence=inferred。
 */
export const FUNNEL_CONFIDENCE_TIERS = ['exact', 'date_level', 'approximate', 'recalled', 'inferred'] as const;
export type FunnelConfidenceTier = (typeof FUNNEL_CONFIDENCE_TIERS)[number];

export const FUNNEL_CONFIDENCE_TIER_LABELS: Record<FunnelConfidenceTier, string> = {
  exact: '精确数据',
  date_level: '日期级数据',
  approximate: '近似数据',
  recalled: '回忆数据',
  inferred: '推断数据',
};

export type FunnelConfidenceCounts = Record<FunnelConfidenceTier, number>;

export interface FunnelConfidenceSummary {
  counts: FunnelConfidenceCounts;
  /** (recalled + inferred) / totalAppliedCount；分母为 0 时为 null。 */
  recalledOrInferredShare: number | null;
  totalAppliedCount: number;
}

export interface FunnelOverview {
  stages: FunnelStageCount[];
  statusCounts: FunnelProcessStatusCounts;
  confidence: FunnelConfidenceSummary;
}

export interface FunnelGroupKey {
  city: string | null;
  jobFamily: JobFamilyId;
  channel: ApplicationChannel;
  resumeVersionId: string | null;
  /** timeGranularity='none' 时固定为 null。 */
  windowLabel: string | null;
}

export interface FunnelGroupResult {
  key: FunnelGroupKey;
  overview: FunnelOverview;
}

export interface FunnelExclusionSummary {
  /** 已作废（含被去重合并）的 Application 数量，未计入任何分组。 */
  voidedApplicationCount: number;
  /** 说明性文案：分母、排除项与可信度边界，供前端直接展示。 */
  notes: string[];
}

export interface FunnelResult {
  query: FunnelQuery;
  /** 不分组时的全局总览（始终计算，供页面默认展示）。 */
  overview: FunnelOverview;
  /** groupBy='none' 时为空数组；否则每个分组对应一个 overview。 */
  groups: FunnelGroupResult[];
  totalProcessCount: number;
  exclusions: FunnelExclusionSummary;
}

export interface FunnelDetailRow {
  applicationId: string;
  company: string;
  role: string;
  jobFamily: JobFamilyId;
  city: string | null;
  channel: ApplicationChannel;
  resumeVersionId: string | null;
  highestReachedStage: FunnelStage;
  status: FunnelProcessStatus;
  confidenceTier: FunnelConfidenceTier;
}

export interface FunnelSourceApplication {
  application: ApplicationRecord;
  job: JobRecord | null;
  events: readonly FeedbackEventRecord[];
}

export type FunnelSourceConfidence = SourceConfidence;
