import type {
  ApplicationChannel,
  ApplicationOutcome,
  ApplicationRecord,
  FeedbackEventRecord,
  SourceConfidence,
} from '../job-memory';
import type { JobRecord } from '../../storage/types';

/**
 * 岗位族分组键：直接取 Job.role 原文（trim 后），不做任何分类推断。
 * 项目当前没有正式的岗位族分类字段/算法，为避免伪造一个看起来"智能"但
 * 实际上是瞎猜的分类器，这里如实按 Job.role 原文分组。
 */
export type RoleFamilyKey = string;

export const FUNNEL_TIME_GRANULARITIES = ['none', 'month', 'quarter'] as const;
export type FunnelTimeGranularity = (typeof FUNNEL_TIME_GRANULARITIES)[number];

export interface FunnelQuery {
  city?: string | null;
  roleFamily?: string | null;
  channel?: ApplicationChannel | null;
  resumeVersionId?: string | null;
  /** 半开区间 [from, to)，按 Application.createdAt 过滤；均为毫秒时间戳。 */
  from?: number | null;
  to?: number | null;
  timeGranularity?: FunnelTimeGranularity;
}

export interface FunnelGroupKey {
  city: string | null;
  roleFamily: RoleFamilyKey;
  channel: ApplicationChannel;
  resumeVersionId: string | null;
  /** timeGranularity='none' 时固定为 null。 */
  windowLabel: string | null;
}

export interface FunnelOutcomeCounts {
  rejected: number;
  userWithdrew: number;
  positionClosed: number;
  stale: number;
  offerDeclined: number;
  offerAccepted: number;
}

export interface FunnelGroupResult {
  key: FunnelGroupKey;
  /** 已确认投递/招聘接触流程数（不含已作废 Application）。 */
  processCount: number;
  /** 有效回复数：HR 已实际回应（非仅已读/暂停/冻结这类弱信号）。 */
  validReplyCount: number;
  /** 曾经推进到筛选阶段及以上的流程数（即使后续被关闭，也按曾达到的最高阶段计）。 */
  reachedScreeningCount: number;
  reachedInterviewingCount: number;
  reachedOfferCount: number;
  /** 招聘方拒绝 / 用户退出 / 岗位关闭 / 过期 / 拒 Offer / 接受 Offer 分别计数。 */
  outcomeCounts: FunnelOutcomeCounts;
  /** 尚未有明确结果（仍在流程中）的数量。 */
  inProgressCount: number;
  /** 回忆或近似来源（recalled/inferred）证据占比，用于提示可信度限制。 */
  recalledDataShare: number;
  /** 精确/近似（exact/approximate）来源数量，供核对 recalledDataShare 分母。 */
  exactOrApproximateCount: number;
}

export interface FunnelExclusionSummary {
  /** 已作废（含被去重合并）的 Application 数量，未计入任何分组。 */
  voidedApplicationCount: number;
  /** 说明性文案：分母、排除项与可信度边界，供前端直接展示。 */
  notes: string[];
}

export interface FunnelResult {
  query: FunnelQuery;
  groups: FunnelGroupResult[];
  totalProcessCount: number;
  exclusions: FunnelExclusionSummary;
}

export interface FunnelSourceApplication {
  application: ApplicationRecord;
  job: JobRecord | null;
  events: readonly FeedbackEventRecord[];
}

export type FunnelSourceConfidence = SourceConfidence;
export type { ApplicationOutcome };
