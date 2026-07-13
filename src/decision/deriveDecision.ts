import type { ApplicationOutcome, ProjectionStatus } from '../domain/job-memory';
import type { ApplyAdvice, CommunicationStatus, JobRecord, StrategyType } from '../storage';
import {
  assertDecisionOpportunityFacts,
  resolveDecisionOpportunityFacts,
  type DecisionOpportunityFacts,
} from './decisionOpportunityFacts';

export type NextActionType =
  | 'send_greeting'
  | 'wait'
  | 'follow_up_once'
  | 'follow_up_with_new_angle'
  | 'close_opportunity'
  | 'continue_conversation'
  | 'prepare_interview'
  | 'pause_watch'
  | 'manual_review';

export type MessageScenario =
  | 'first_greeting'
  | 'high_salary_low_match_probe'
  | 'second_followup'
  | 'final_unread_followup'
  | 'premium_but_cold_closing'
  | 'hr_reply_bridge';

export interface DerivedDecision {
  strategy: StrategyType;
  nextAction: NextActionType | null;
  stopLoss: boolean;
  scenario: MessageScenario;
  companyWarning?: string;
  flowNotice?: string;
}

export interface DecisionContext {
  now?: number;
  companyOpportunities?: readonly DecisionOpportunityFacts[];
  companyWarningMode?: 'trusted' | 'legacy';
}

export const FOLLOWUP_COOLDOWN_DAYS = 3;
export const MAX_FOLLOWUPS = 2;

const WARNING_EXISTING_MAIN_ATTACK =
  '该公司已有其他岗位处于主攻推进，当前机会建议控制投入，避免重复消耗。';
const WARNING_EXISTING_REPLY_OR_INTERVIEW =
  '该公司已有岗位进入沟通或面试推进，建议优先维护已有入口，避免多线打扰。';
const WARNING_MULTIPLE_COLD_OPPORTUNITIES =
  '该公司已有多个岗位未读或未回，建议降低投入，避免继续消耗精力。';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HIGH_MATCH_ADVICES: ReadonlySet<ApplyAdvice> = new Set(['strongly', 'ok']);

interface CommunicationDecisionFacts {
  communicationStatus: CommunicationStatus;
  followupCount: number;
  lastGreetedAt: number | null;
  lastFollowupAt: number | null;
  nextAllowedFollowUpAt: number | null;
  isClosed: boolean;
  outcome: ApplicationOutcome;
  projectionStatus: ProjectionStatus | null;
}

function communicationFacts(facts: DecisionOpportunityFacts): CommunicationDecisionFacts | null {
  if (facts.source === 'opportunity_only') return null;
  if (facts.source === 'application_projection') {
    const projection = facts.application.projection;
    return {
      communicationStatus: projection.communicationStatus,
      followupCount: projection.followUpCount,
      lastGreetedAt: projection.lastGreetedAt,
      lastFollowupAt: projection.lastFollowUpAt,
      nextAllowedFollowUpAt: projection.nextAllowedFollowUpAt,
      isClosed: projection.isClosed,
      outcome: projection.outcome,
      projectionStatus: projection.projectionStatus,
    };
  }
  const legacy = facts.legacyCommunication;
  const lastActionAt = legacy.lastFollowupAt ?? legacy.lastGreetedAt;
  return {
    communicationStatus: legacy.communicationStatus,
    followupCount: legacy.followupCount,
    lastGreetedAt: legacy.lastGreetedAt,
    lastFollowupAt: legacy.lastFollowupAt,
    nextAllowedFollowUpAt: lastActionAt === null
      ? null
      : lastActionAt + FOLLOWUP_COOLDOWN_DAYS * MS_PER_DAY,
    isClosed: legacy.communicationStatus === 'closed' || legacy.communicationStatus === 'rejected',
    outcome: legacy.communicationStatus === 'rejected' ? 'rejected' : null,
    projectionStatus: null,
  };
}

export function deriveDecision(
  facts: DecisionOpportunityFacts,
  context: DecisionContext = {},
): DerivedDecision {
  assertDecisionOpportunityFacts(facts);
  const now = context.now ?? Date.now();
  const decision = deriveBaseDecision(facts, now);
  const companyWarning = context.companyOpportunities === undefined
    ? undefined
    : context.companyWarningMode === 'legacy'
      ? deriveLegacyCompanyWarning(
          facts.job,
          context.companyOpportunities.map((opportunity) => opportunity.job),
          now,
        )
      : deriveCompanyWarning(facts, context.companyOpportunities, now);
  return companyWarning === undefined ? decision : { ...decision, companyWarning };
}

export function deriveLegacyDecision(
  job: JobRecord,
  allJobs?: readonly JobRecord[],
  now = Date.now(),
): DerivedDecision {
  const facts = resolveDecisionOpportunityFacts({
    job,
    selectedApplication: null,
    defaultApplication: null,
    jobMemoryV2Enabled: false,
  });
  const companyOpportunities = allJobs?.map((candidate) => resolveDecisionOpportunityFacts({
    job: candidate,
    selectedApplication: null,
    defaultApplication: null,
    jobMemoryV2Enabled: false,
  }));
  return deriveDecision(facts, {
    now,
    companyOpportunities,
    companyWarningMode: 'legacy',
  });
}

export function normalizeCompanyName(company?: string): string {
  return (company ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function trustedProcessEvidence(facts: DecisionOpportunityFacts): CommunicationDecisionFacts | null {
  const communication = communicationFacts(facts);
  if (communication === null) return null;
  if (facts.source === 'application_projection' && communication.projectionStatus === 'invalid') {
    return null;
  }
  return communication;
}

export function deriveCompanyWarning(
  currentFacts: DecisionOpportunityFacts,
  allFacts: readonly DecisionOpportunityFacts[],
  now = Date.now(),
): string | undefined {
  const companyName = normalizeCompanyName(currentFacts.job.company);
  if (companyName === '') return undefined;
  const sameCompanyFacts = allFacts.filter((facts) => (
    facts.job.id !== currentFacts.job.id
    && normalizeCompanyName(facts.job.company) === companyName
    && trustedProcessEvidence(facts) !== null
  ));
  if (sameCompanyFacts.length === 0) return undefined;

  if (sameCompanyFacts.some((facts) => {
    const status = trustedProcessEvidence(facts)?.communicationStatus;
    return status === 'replied' || status === 'interviewing';
  })) return WARNING_EXISTING_REPLY_OR_INTERVIEW;

  const currentStrategy = deriveBaseDecision(currentFacts, now).strategy;
  const hasOtherMainAttack = sameCompanyFacts.some((facts) => {
    const process = trustedProcessEvidence(facts);
    return process !== null
      && !process.isClosed
      && deriveBaseDecision(facts, now).strategy === 'main_attack';
  });
  if (hasOtherMainAttack && currentStrategy !== 'main_attack') return WARNING_EXISTING_MAIN_ATTACK;

  const coldCount = sameCompanyFacts.filter((facts) => {
    const status = trustedProcessEvidence(facts)?.communicationStatus;
    return status === 'greeted_unread' || status === 'greeted_read_no_reply';
  }).length;
  return coldCount >= 2 ? WARNING_MULTIPLE_COLD_OPPORTUNITIES : undefined;
}

export function deriveLegacyCompanyWarning(
  currentJob: JobRecord,
  allJobs: readonly JobRecord[],
  now = Date.now(),
): string | undefined {
  const companyName = normalizeCompanyName(currentJob.company);
  if (companyName === '') return undefined;
  const sameCompanyJobs = allJobs.filter((job) => (
    job.id !== currentJob.id && normalizeCompanyName(job.company) === companyName
  ));
  if (sameCompanyJobs.length === 0) return undefined;
  if (sameCompanyJobs.some((job) => (
    job.communicationStatus === 'replied' || job.communicationStatus === 'interviewing'
  ))) return WARNING_EXISTING_REPLY_OR_INTERVIEW;

  const currentStrategy = deriveLegacyDecision(currentJob, undefined, now).strategy;
  const hasOtherMainAttack = sameCompanyJobs.some((job) => {
    const active = job.communicationStatus !== 'closed' && job.communicationStatus !== 'rejected';
    return active && deriveLegacyDecision(job, undefined, now).strategy === 'main_attack';
  });
  if (hasOtherMainAttack && currentStrategy !== 'main_attack') return WARNING_EXISTING_MAIN_ATTACK;

  const coldCount = sameCompanyJobs.filter((job) => (
    job.communicationStatus === 'greeted_unread'
    || job.communicationStatus === 'greeted_read_no_reply'
  )).length;
  return coldCount >= 2 ? WARNING_MULTIPLE_COLD_OPPORTUNITIES : undefined;
}

function isPendingReviewForStatus(job: JobRecord, status: JobRecord['communicationStatus']): boolean {
  if (status === 'closed' || status === 'rejected') return false;
  if (job.reviewStatus === 'pending_review') return true;
  if (job.reviewStatus === 'confirmed' || job.reviewStatus === 'deferred' || job.reviewStatus === 'rejected') {
    return false;
  }
  return job.importedDraft !== undefined && job.importStatus === 'imported_draft';
}

function deriveBaseDecision(facts: DecisionOpportunityFacts, now: number): DerivedDecision {
  const job = facts.job;
  const process = communicationFacts(facts);
  const reviewStatus = process?.communicationStatus ?? 'not_contacted';
  if (isPendingReviewForStatus(job, reviewStatus)) {
    return {
      strategy: 'cautious_watch', nextAction: 'manual_review', stopLoss: false,
      scenario: 'first_greeting',
    };
  }
  if (job.reviewStatus === 'deferred') {
    return {
      strategy: 'cautious_watch', nextAction: 'pause_watch', stopLoss: false,
      scenario: 'first_greeting',
    };
  }
  if (job.reviewStatus === 'rejected') {
    return {
      strategy: 'cut_loss', nextAction: null, stopLoss: false,
      scenario: 'premium_but_cold_closing',
    };
  }
  if (facts.source === 'application_projection' && process?.projectionStatus === 'invalid') {
    return {
      strategy: 'cautious_watch', nextAction: 'manual_review', stopLoss: false,
      scenario: 'first_greeting', flowNotice: '流程事实无法安全计算，请查看时间线诊断并人工纠错。',
    };
  }
  if (process === null) return decisionForOpportunity(job);

  const terminal = terminalDecision(process);
  if (terminal !== null) return terminal;
  switch (process.communicationStatus) {
    case 'replied':
      return {
        strategy: 'main_attack', nextAction: 'continue_conversation', stopLoss: false,
        scenario: 'hr_reply_bridge',
      };
    case 'interviewing':
      return {
        strategy: 'main_attack', nextAction: 'prepare_interview', stopLoss: false,
        scenario: 'hr_reply_bridge',
      };
    case 'paused':
      return {
        strategy: 'cautious_watch', nextAction: 'pause_watch', stopLoss: false,
        scenario: 'first_greeting',
      };
    case 'not_contacted':
      return decisionForOpportunity(job);
    case 'greeted_unread':
    case 'greeted_read_no_reply':
      return decisionForFollowup(job, process, now);
    case 'closed':
    case 'rejected':
      return closedDecision('流程已结束。');
    default: {
      const exhaustive: never = process.communicationStatus;
      return exhaustive;
    }
  }
}

function terminalDecision(process: CommunicationDecisionFacts): DerivedDecision | null {
  switch (process.outcome) {
    case null:
      return process.isClosed ? closedDecision('流程已关闭。') : null;
    case 'offer_accepted':
      return {
        strategy: 'main_attack', nextAction: null, stopLoss: false,
        scenario: 'hr_reply_bridge', flowNotice: 'Offer 已接受，流程成功结束。',
      };
    case 'rejected':
      return closedDecision('招聘方已拒绝，停止继续跟进。');
    case 'user_withdrew':
      return closedDecision('你已主动退出该流程。');
    case 'position_closed':
      return closedDecision('岗位已关闭。');
    case 'stale':
      return closedDecision('流程已标记失效。');
    case 'offer_declined':
      return closedDecision('你已拒绝该 Offer。');
    default: {
      const exhaustive: never = process.outcome;
      return exhaustive;
    }
  }
}

function closedDecision(flowNotice: string): DerivedDecision {
  return {
    strategy: 'cut_loss', nextAction: null, stopLoss: false,
    scenario: 'premium_but_cold_closing', flowNotice,
  };
}

function decisionForOpportunity(job: JobRecord): DerivedDecision {
  const advice = job.report?.applyAdvice ?? '';
  if (advice === '') return emptyReportFallback();
  if (HIGH_MATCH_ADVICES.has(advice)) {
    return {
      strategy: 'main_attack', nextAction: 'send_greeting', stopLoss: false,
      scenario: 'first_greeting',
    };
  }
  if (job.highValueSignal === true) {
    return {
      strategy: 'low_cost_probe', nextAction: 'send_greeting', stopLoss: false,
      scenario: 'high_salary_low_match_probe',
    };
  }
  return emptyReportFallback();
}

function emptyReportFallback(): DerivedDecision {
  return {
    strategy: 'cautious_watch', nextAction: 'wait', stopLoss: false,
    scenario: 'first_greeting',
  };
}

function decisionForFollowup(
  job: JobRecord,
  process: CommunicationDecisionFacts,
  now: number,
): DerivedDecision {
  if (process.followupCount >= MAX_FOLLOWUPS) {
    return {
      strategy: 'cut_loss', nextAction: 'close_opportunity', stopLoss: true,
      scenario: 'premium_but_cold_closing',
    };
  }
  const cooledDown = process.nextAllowedFollowUpAt !== null
    && now >= process.nextAllowedFollowUpAt;
  if (process.communicationStatus === 'greeted_unread') {
    if (!cooledDown) return waitForFollowup();
    if (process.followupCount === 0) {
      return {
        strategy: activeFollowupStrategy(job), nextAction: 'follow_up_once', stopLoss: false,
        scenario: 'second_followup',
      };
    }
  }
  if (process.communicationStatus === 'greeted_read_no_reply' && process.followupCount === 0) {
    return {
      strategy: activeFollowupStrategy(job), nextAction: 'follow_up_with_new_angle', stopLoss: false,
      scenario: 'second_followup',
    };
  }
  if (process.followupCount === 1 && cooledDown) {
    return {
      strategy: activeFollowupStrategy(job), nextAction: 'follow_up_with_new_angle', stopLoss: false,
      scenario: 'final_unread_followup',
    };
  }
  return waitForFollowup();
}

function waitForFollowup(): DerivedDecision {
  return {
    strategy: 'cautious_watch', nextAction: 'wait', stopLoss: false,
    scenario: 'second_followup',
  };
}

function activeFollowupStrategy(job: JobRecord): StrategyType {
  const advice = job.report?.applyAdvice ?? '';
  if (advice !== '' && HIGH_MATCH_ADVICES.has(advice)) return 'main_attack';
  if (job.highValueSignal === true) return 'low_cost_probe';
  return 'cautious_watch';
}
