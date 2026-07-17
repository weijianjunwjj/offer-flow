import { projectApplication } from '../job-memory/projectApplication';
import type { FeedbackEventRecord, FeedbackEventType } from '../job-memory';
import { deriveJobFamily } from './jobFamily';
import {
  FUNNEL_CONFIDENCE_TIERS,
  FUNNEL_PROCESS_STATUSES,
  FUNNEL_STAGES,
  type FunnelConfidenceCounts,
  type FunnelConfidenceSummary,
  type FunnelConfidenceTier,
  type FunnelDetailRow,
  type FunnelExclusionSummary,
  type FunnelGroupDimension,
  type FunnelGroupKey,
  type FunnelGroupResult,
  type FunnelOverview,
  type FunnelProcessStatus,
  type FunnelProcessStatusCounts,
  type FunnelQuery,
  type FunnelResult,
  type FunnelSourceApplication,
  type FunnelStage,
  type FunnelStageCount,
  type FunnelTimeGranularity,
} from './types';

/**
 * 事件类型 → 曾经推进到的最高漏斗阶段。只用于统计口径下"曾达到"计数，
 * 不复用 projectApplication 的当前状态机——流程被暂停/关闭后仍应计入其曾经到达的最高阶段。
 */
const STAGE_RANK: Record<FunnelStage, number> = Object.fromEntries(
  FUNNEL_STAGES.map((stage, index) => [stage, index]),
) as Record<FunnelStage, number>;

const REACHED_STAGE_BY_EVENT_TYPE: Partial<Record<FeedbackEventType, FunnelStage>> = {
  applied: 'applied',
  hr_replied: 'valid_reply',
  resume_requested: 'resume_requested',
  phone_screen: 'phone_screen',
  interview_scheduled: 'interview_scheduled',
  interview_completed: 'interview_completed',
  interview_advanced: 'interview_advanced',
  offer_received: 'offer_received',
  offer_accepted: 'offer_accepted',
};

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

function highestReachedStage(events: readonly FeedbackEventRecord[]): FunnelStage | null {
  let best: FunnelStage | null = null;
  for (const event of events) {
    const stage = REACHED_STAGE_BY_EVENT_TYPE[event.eventType];
    if (stage === undefined) continue;
    if (best === null || STAGE_RANK[stage] > STAGE_RANK[best]) best = stage;
  }
  if (best === null) return null;
  // 面试安排及以上必然意味着已经过某种简历筛选/电话沟通，即使历史事件中未单独记录。
  if (STAGE_RANK[best] >= STAGE_RANK.interview_scheduled) return best;
  return best;
}

function hasValidReply(events: readonly FeedbackEventRecord[]): boolean {
  return events.some((event) => VALID_REPLY_EVENT_TYPES.has(event.eventType));
}

function eventTime(event: FeedbackEventRecord): number {
  return event.eventAt ?? event.createdAt;
}

/**
 * 流程当前状态判定。规则按业务优先级顺序求值：
 * 1. 正式终态事件（rejected / user_withdrew / offer_declined / position_closed / offer_accepted）
 *    一旦出现即为对应终态，但如果之后又出现了更晚的有效推进/恢复事件，则说明该终态被后续事实覆盖
 *    （数据补录顺序问题或状态被纠正），改用最后一个有效事件重新判定。
 * 2. 暂停/冻结（recruitment_paused / recruitment_frozen）之后若没有 process_resumed 或更晚的推进事件，
 *    计入 paused_frozen，不计入拒绝或进行中。
 * 3. 无回复/标记沉默（no_response_recorded / marked_stale）之后若没有恢复或推进事件，计入 stale。
 * 4. 否则计入 in_progress。
 *
 * "之后没有更晚事件"统一按事件的 effective time（eventAt ?? createdAt）比较，
 * 保证事件按业务时间而非写入顺序判定覆盖关系。
 */
const TERMINAL_STATUS_BY_EVENT_TYPE: Partial<Record<FeedbackEventType, FunnelProcessStatus>> = {
  rejected: 'rejected_by_recruiter',
  user_withdrew: 'user_withdrew',
  offer_declined: 'user_withdrew',
  position_closed: 'position_closed',
  offer_accepted: 'offer_accepted',
};

const RECOVERY_EVENT_TYPES: ReadonlySet<FeedbackEventType> = new Set([
  'process_resumed',
  'hr_replied',
  'resume_requested',
  'phone_screen',
  'interview_scheduled',
  'interview_completed',
  'interview_advanced',
  'offer_received',
]);

function deriveProcessStatus(events: readonly FeedbackEventRecord[]): FunnelProcessStatus {
  const sorted = [...events].sort((left, right) => eventTime(left) - eventTime(right));

  let terminal: { status: FunnelProcessStatus; at: number } | null = null;
  let pausedAt: number | null = null;
  let resumedAfterPauseAt: number | null = null;
  let staleAt: number | null = null;
  let recoveredAfterStaleAt: number | null = null;

  for (const event of sorted) {
    const at = eventTime(event);
    const terminalStatus = TERMINAL_STATUS_BY_EVENT_TYPE[event.eventType];
    if (terminalStatus !== undefined) {
      terminal = { status: terminalStatus, at };
      continue;
    }
    if (event.eventType === 'recruitment_paused' || event.eventType === 'recruitment_frozen') {
      pausedAt = at;
      resumedAfterPauseAt = null;
      continue;
    }
    if (event.eventType === 'no_response_recorded' || event.eventType === 'marked_stale') {
      staleAt = at;
      recoveredAfterStaleAt = null;
      continue;
    }
    if (RECOVERY_EVENT_TYPES.has(event.eventType)) {
      if (pausedAt !== null && at > pausedAt) resumedAfterPauseAt = at;
      if (staleAt !== null && at > staleAt) recoveredAfterStaleAt = at;
    }
  }

  if (terminal !== null) {
    const pausedOverridesTerminal = pausedAt !== null && pausedAt > terminal.at
      && (resumedAfterPauseAt === null || resumedAfterPauseAt <= pausedAt);
    const staleOverridesTerminal = staleAt !== null && staleAt > terminal.at
      && (recoveredAfterStaleAt === null || recoveredAfterStaleAt <= staleAt);
    if (!pausedOverridesTerminal && !staleOverridesTerminal) return terminal.status;
  }

  if (pausedAt !== null && (resumedAfterPauseAt === null || resumedAfterPauseAt < pausedAt)) {
    if (staleAt === null || pausedAt >= staleAt) return 'paused_frozen';
  }

  if (staleAt !== null && (recoveredAfterStaleAt === null || recoveredAfterStaleAt < staleAt)) {
    return 'stale';
  }

  return 'in_progress';
}

/**
 * 流程级数据可信度分级：以该流程正式投递事实（application_created 事件）的
 * sourceConfidence + timePrecision 为口径，不在组件里临时拼。找不到
 * application_created 事件时退化为该流程全部事件中最低置信度的一条。
 */
function deriveConfidenceTier(events: readonly FeedbackEventRecord[]): FunnelConfidenceTier {
  const founding = events.find((event) => event.eventType === 'application_created') ?? events[0];
  if (founding === undefined) return 'inferred';
  if (founding.sourceConfidence === 'recalled') return 'recalled';
  if (founding.sourceConfidence === 'inferred') return 'inferred';
  if (founding.sourceConfidence === 'approximate') return 'approximate';
  return founding.timePrecision === 'date' ? 'date_level' : 'exact';
}

function emptyStatusCounts(): FunnelProcessStatusCounts {
  return Object.fromEntries(FUNNEL_PROCESS_STATUSES.map((status) => [status, 0])) as FunnelProcessStatusCounts;
}

function emptyConfidenceCounts(): FunnelConfidenceCounts {
  return Object.fromEntries(FUNNEL_CONFIDENCE_TIERS.map((tier) => [tier, 0])) as FunnelConfidenceCounts;
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

function cityOf(source: FunnelSourceApplication): string | null {
  const city = source.application.cityContext.jobCity ?? source.job?.city ?? null;
  const trimmed = city?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : null;
}

function matchesQuery(source: FunnelSourceApplication, query: FunnelQuery): boolean {
  if (query.city !== undefined && query.city !== null && cityOf(source) !== query.city) return false;
  if (
    query.jobFamily !== undefined
    && query.jobFamily !== null
    && deriveJobFamily(source.job?.role) !== query.jobFamily
  ) {
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

function groupKeyOf(
  source: FunnelSourceApplication,
  dimension: FunnelGroupDimension,
  granularity: FunnelTimeGranularity,
): FunnelGroupKey {
  return {
    city: dimension === 'city' ? cityOf(source) : null,
    jobFamily: dimension === 'jobFamily' ? deriveJobFamily(source.job?.role) : 'uncategorized',
    channel: dimension === 'channel' ? source.application.channel : 'unknown',
    resumeVersionId: dimension === 'resumeVersion' ? source.application.resumeVersionId : null,
    windowLabel: windowLabelFor(source.application.createdAt, granularity),
  };
}

function groupKeyToken(key: FunnelGroupKey): string {
  return JSON.stringify([key.city, key.jobFamily, key.channel, key.resumeVersionId, key.windowLabel]);
}

interface ProcessFacts {
  highestStage: FunnelStage | null;
  hasValidReply: boolean;
  status: FunnelProcessStatus;
  confidenceTier: FunnelConfidenceTier;
}

function factsOf(source: FunnelSourceApplication): ProcessFacts {
  return {
    highestStage: highestReachedStage(source.events),
    hasValidReply: hasValidReply(source.events),
    status: deriveProcessStatus(source.events),
    confidenceTier: deriveConfidenceTier(source.events),
  };
}

function stageReached(facts: ProcessFacts, stage: FunnelStage): boolean {
  if (stage === 'applied') return true;
  if (stage === 'valid_reply') return facts.hasValidReply;
  if (facts.highestStage === null) return false;
  return STAGE_RANK[facts.highestStage] >= STAGE_RANK[stage];
}

function buildOverview(processes: readonly ProcessFacts[]): FunnelOverview {
  const appliedCount = processes.length;
  const stages: FunnelStageCount[] = FUNNEL_STAGES.map((stage, index) => {
    const count = processes.filter((facts) => stageReached(facts, stage)).length;
    const previousCount = index === 0 ? null : processes.filter(
      (facts) => stageReached(facts, FUNNEL_STAGES[index - 1] as FunnelStage),
    ).length;
    return {
      stage,
      count,
      conversionFromPrevious: index === 0
        ? null
        : (previousCount === null || previousCount === 0 ? null : count / previousCount),
      conversionFromApplied: index === 0
        ? (appliedCount === 0 ? null : 1)
        : (appliedCount === 0 ? null : count / appliedCount),
    };
  });

  const statusCounts = emptyStatusCounts();
  for (const facts of processes) statusCounts[facts.status] += 1;

  const confidenceCounts = emptyConfidenceCounts();
  for (const facts of processes) confidenceCounts[facts.confidenceTier] += 1;
  const recalledOrInferredCount = confidenceCounts.recalled + confidenceCounts.inferred;
  const confidence: FunnelConfidenceSummary = {
    counts: confidenceCounts,
    recalledOrInferredShare: appliedCount === 0 ? null : recalledOrInferredCount / appliedCount,
    totalAppliedCount: appliedCount,
  };

  return { stages, statusCounts, confidence };
}

/**
 * 从正式 Application + FeedbackEvent 只读聚合出基础漏斗。不持久化任何派生统计表，
 * 每次调用都直接基于传入的 source 重新计算。
 *
 * 默认（groupBy='none' 或未指定）只返回全局总览，不做任何分组——城市、岗位族、渠道、
 * 简历版本一次只能选择一个维度分组，不再拼接复合分组键。分组与筛选相互独立：
 * query 的其余字段（city/jobFamily/channel/resumeVersionId/from/to）始终用于缩小样本，
 * 与 groupBy 选择的分组维度无关，因此可以"按城市分组，同时筛选渠道"。
 *
 * 排除规则：
 * - 已作废（voidedAt !== null）的 Application 不进入任何统计，计入 exclusions.voidedApplicationCount；
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
  const dimension = query.groupBy ?? 'none';
  const groupsByToken = new Map<string, { key: FunnelGroupKey; processes: ProcessFacts[] }>();
  const allProcesses: ProcessFacts[] = [];
  let voidedApplicationCount = 0;
  let invalidProjectionCount = 0;

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

    const facts = factsOf(source);
    allProcesses.push(facts);

    if (dimension !== 'none') {
      const key = groupKeyOf(source, dimension, granularity);
      const token = groupKeyToken(key);
      let group = groupsByToken.get(token);
      if (group === undefined) {
        group = { key, processes: [] };
        groupsByToken.set(token, group);
      }
      group.processes.push(facts);
    }
  }

  const groups: FunnelGroupResult[] = Array.from(groupsByToken.values()).map((group) => ({
    key: group.key,
    overview: buildOverview(group.processes),
  }));

  const notes = [
    '分母仅统计已确认创建的 Application（未投递的历史记录从不进入分母）。',
    '已作废的 Application 不计入任何统计。',
    '默认展示全局总览，不做任何分组；分组一次只能选择一个维度（城市/岗位族/渠道/简历版本），筛选与分组维度相互独立。',
    '各阶段按流程历史上是否曾达到该阶段计数（单调统计），不受后续暂停、拒绝或关闭影响。',
    '面试安排及以上阶段视为已自动到达索要简历与电话沟通阶段，即使历史事件未单独记录。',
    '无回复/标记沉默、招聘暂停/冻结不计为招聘方拒绝，也不计入进行中；后续出现的有效推进或恢复事件可覆盖这两种状态。',
    '岗位族由岗位标题按规则归类，原始岗位名称可在明细中查看；无法确定时归入"其他/待归类"。',
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

  return {
    query,
    overview: buildOverview(allProcesses),
    groups,
    totalProcessCount: allProcesses.length,
    exclusions,
  };
}

/**
 * 明细钻取：逐条列出参与统计的流程（应用与筛选条件后），供页面钻取查看。
 * 默认不暴露内部字段（applicationId 仅用于前端 key，不在表格中直接展示）。
 */
export function listFunnelDetailRows(
  sources: readonly FunnelSourceApplication[],
  query: FunnelQuery = {},
): FunnelDetailRow[] {
  const rows: FunnelDetailRow[] = [];
  for (const source of sources) {
    if (source.application.voidedAt !== null) continue;
    if (!matchesQuery(source, query)) continue;
    const projection = projectApplication(source.application, source.events);
    if (projection.projectionStatus === 'invalid') continue;

    const facts = factsOf(source);
    rows.push({
      applicationId: source.application.id,
      company: source.job?.company ?? '未知公司',
      role: source.job?.role ?? '未分类岗位',
      jobFamily: deriveJobFamily(source.job?.role),
      city: cityOf(source),
      channel: source.application.channel,
      resumeVersionId: source.application.resumeVersionId,
      highestReachedStage: facts.highestStage ?? 'applied',
      status: facts.status,
      confidenceTier: facts.confidenceTier,
    });
  }
  return rows;
}
