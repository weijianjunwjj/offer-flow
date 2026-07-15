import { projectApplication } from '../job-memory/projectApplication';
import type { ApplicationOutcome, FeedbackEventRecord, FeedbackEventType } from '../job-memory';
import type {
  FunnelExclusionSummary,
  FunnelGroupKey,
  FunnelGroupResult,
  FunnelOutcomeCounts,
  FunnelQuery,
  FunnelResult,
  FunnelSourceApplication,
  FunnelTimeGranularity,
} from './types';

/**
 * 事件类型 → "曾经推进到的最高阶段" 的映射。只用于统计口径下的"曾达到"计数，
 * 不复用 projectApplication 的当前状态机——流程被暂停/关闭后仍应计入其曾经到达的最高阶段。
 * 不处理 event_voided 对目标事件的作废（见 FunnelExclusionSummary.notes 中的口径说明）。
 */
const REACHED_RANK_BY_EVENT_TYPE: Partial<Record<FeedbackEventType, number>> = {
  applied: 1,
  hr_contacted: 2,
  greeting_sent: 2,
  message_viewed: 2,
  hr_replied: 2,
  follow_up_sent: 2,
  resume_requested: 3,
  phone_screen: 3,
  interview_scheduled: 4,
  interview_completed: 4,
  interview_advanced: 4,
  offer_received: 5,
  offer_accepted: 5,
  offer_declined: 5,
};

const RANK_SCREENING = 3;
const RANK_INTERVIEWING = 4;
const RANK_OFFER = 5;

/** 有效回复：HR/面试官等发生了超出"已读未回"这类弱信号的真实互动。 */
const VALID_REPLY_EVENT_TYPES: ReadonlySet<FeedbackEventType> = new Set([
  'hr_replied',
  'resume_requested',
  'phone_screen',
  'interview_scheduled',
  'interview_completed',
  'interview_advanced',
  'offer_received',
  'offer_accepted',
  'offer_declined',
  'rejected',
]);

function maxReachedRank(events: readonly FeedbackEventRecord[]): number {
  let rank = 0;
  for (const event of events) {
    const eventRank = REACHED_RANK_BY_EVENT_TYPE[event.eventType];
    if (eventRank !== undefined && eventRank > rank) rank = eventRank;
  }
  return rank;
}

function hasValidReply(events: readonly FeedbackEventRecord[]): boolean {
  return events.some((event) => VALID_REPLY_EVENT_TYPES.has(event.eventType));
}

function emptyOutcomeCounts(): FunnelOutcomeCounts {
  return {
    rejected: 0,
    userWithdrew: 0,
    positionClosed: 0,
    stale: 0,
    offerDeclined: 0,
    offerAccepted: 0,
  };
}

function addOutcome(counts: FunnelOutcomeCounts, outcome: ApplicationOutcome): void {
  switch (outcome) {
    case 'rejected':
      counts.rejected += 1;
      return;
    case 'user_withdrew':
      counts.userWithdrew += 1;
      return;
    case 'position_closed':
      counts.positionClosed += 1;
      return;
    case 'stale':
      counts.stale += 1;
      return;
    case 'offer_declined':
      counts.offerDeclined += 1;
      return;
    case 'offer_accepted':
      counts.offerAccepted += 1;
      return;
    case null:
      return;
  }
}

function windowLabelFor(createdAt: number, granularity: FunnelTimeGranularity): string | null {
  if (granularity === 'none') return null;
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  if (granularity === 'month') {
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

function roleFamilyOf(job: FunnelSourceApplication['job']): string {
  const role = job?.role?.trim();
  return role !== undefined && role.length > 0 ? role : '未分类岗位';
}

function cityOf(source: FunnelSourceApplication): string | null {
  const city = source.application.cityContext.jobCity ?? source.job?.city ?? null;
  const trimmed = city?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function matchesQuery(source: FunnelSourceApplication, query: FunnelQuery): boolean {
  if (query.city !== undefined && query.city !== null && cityOf(source) !== query.city) return false;
  if (query.roleFamily !== undefined && query.roleFamily !== null && roleFamilyOf(source.job) !== query.roleFamily) {
    return false;
  }
  if (
    query.channel !== undefined
    && query.channel !== null
    && source.application.channel !== query.channel
  ) {
    return false;
  }
  if (
    query.resumeVersionId !== undefined
    && query.resumeVersionId !== null
    && source.application.resumeVersionId !== query.resumeVersionId
  ) {
    return false;
  }
  const createdAt = source.application.createdAt;
  if (query.from !== undefined && query.from !== null && createdAt < query.from) return false;
  if (query.to !== undefined && query.to !== null && createdAt >= query.to) return false;
  return true;
}

function groupKeyOf(source: FunnelSourceApplication, granularity: FunnelTimeGranularity): FunnelGroupKey {
  return {
    city: cityOf(source),
    roleFamily: roleFamilyOf(source.job),
    channel: source.application.channel,
    resumeVersionId: source.application.resumeVersionId,
    windowLabel: windowLabelFor(source.application.createdAt, granularity),
  };
}

function groupKeyToken(key: FunnelGroupKey): string {
  return JSON.stringify([key.city, key.roleFamily, key.channel, key.resumeVersionId, key.windowLabel]);
}

/**
 * 从正式 Application + FeedbackEvent 只读聚合出基础漏斗。不持久化任何派生统计表，
 * 每次调用都直接基于传入的 source 重新计算。
 *
 * 排除规则：
 * - 已作废（voidedAt !== null）的 Application 不进入任何分组，计入 exclusions.voidedApplicationCount；
 * - 未投递（actuallyApplied=false，即未真正创建 Application 的历史草稿）从不会出现在 source 中，
 *   因为它们在补录确认时压根不会 materialize 成 Application——分母天然不含它们；
 * - projectApplication 判定为 invalid（projectionStatus='invalid'）的记录被跳过并计入 notes，
 *   避免用结构性错误的数据污染统计。
 */
export function aggregateFunnel(
  sources: readonly FunnelSourceApplication[],
  query: FunnelQuery = {},
): FunnelResult {
  const granularity = query.timeGranularity ?? 'none';
  const groupsByToken = new Map<string, FunnelGroupResult>();
  const recalledCountByToken = new Map<string, number>();
  let voidedApplicationCount = 0;
  let invalidProjectionCount = 0;
  let totalProcessCount = 0;

  for (const source of sources) {
    if (source.application.voidedAt !== null) {
      voidedApplicationCount += 1;
      continue;
    }
    if (!matchesQuery(source, query)) continue;

    const projection = projectApplication(source.application, source.events);
    if (projection.projectionStatus === 'invalid') {
      invalidProjectionCount += 1;
      continue;
    }

    const key = groupKeyOf(source, granularity);
    const token = groupKeyToken(key);
    let group = groupsByToken.get(token);
    if (group === undefined) {
      group = {
        key,
        processCount: 0,
        validReplyCount: 0,
        reachedScreeningCount: 0,
        reachedInterviewingCount: 0,
        reachedOfferCount: 0,
        outcomeCounts: emptyOutcomeCounts(),
        inProgressCount: 0,
        recalledDataShare: 0,
        exactOrApproximateCount: 0,
      };
      groupsByToken.set(token, group);
    }

    group.processCount += 1;
    totalProcessCount += 1;
    if (hasValidReply(source.events)) group.validReplyCount += 1;
    const rank = maxReachedRank(source.events);
    if (rank >= RANK_SCREENING) group.reachedScreeningCount += 1;
    if (rank >= RANK_INTERVIEWING) group.reachedInterviewingCount += 1;
    if (rank >= RANK_OFFER) group.reachedOfferCount += 1;

    if (projection.outcome === null) {
      group.inProgressCount += 1;
    } else {
      addOutcome(group.outcomeCounts, projection.outcome);
    }

    const recalledOrInferred = source.events.filter(
      (event) => event.sourceConfidence === 'recalled' || event.sourceConfidence === 'inferred',
    ).length;
    const exactOrApproximate = source.events.length - recalledOrInferred;
    recalledCountByToken.set(token, (recalledCountByToken.get(token) ?? 0) + recalledOrInferred);
    group.exactOrApproximateCount += exactOrApproximate;
  }

  const groups = Array.from(groupsByToken.entries()).map(([token, group]) => {
    const recalledCount = recalledCountByToken.get(token) ?? 0;
    const totalEvidence = recalledCount + group.exactOrApproximateCount;
    return {
      ...group,
      recalledDataShare: totalEvidence === 0 ? 0 : recalledCount / totalEvidence,
    };
  });

  const notes = [
    '分母仅统计已确认创建的 Application（未投递的历史记录从不进入分母）。',
    '已作废的 Application 不计入任何分组或分母。',
    '用户主动退出（user_withdrew）不计为招聘方拒绝；岗位关闭（position_closed）不代表候选人能力被否定。',
    '曾经推进到筛选/面试/Offer 阶段按流程历史上到达过的最高阶段计数，不受后续暂停或关闭影响。',
    '回忆/推断来源（recalled/inferred）数据占比越高，结论可信度越低，请结合 recalledDataShare 判断。',
  ];
  if (voidedApplicationCount > 0) {
    notes.push(`已排除 ${voidedApplicationCount} 条已作废 Application，未计入分母。`);
  }
  if (invalidProjectionCount > 0) {
    notes.push(`已排除 ${invalidProjectionCount} 条投影校验失败（projectionStatus=invalid）的记录，未计入分母。`);
  }

  const exclusions: FunnelExclusionSummary = {
    voidedApplicationCount,
    notes,
  };

  return { query, groups, totalProcessCount, exclusions };
}
