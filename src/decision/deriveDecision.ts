import type { ApplyAdvice, JobRecord, StrategyType } from '../storage';

export type NextActionType =
  | 'send_greeting'
  | 'wait'
  | 'follow_up_once'
  | 'follow_up_with_new_angle'
  | 'close_opportunity'
  | 'continue_conversation'
  | 'prepare_interview'
  | 'pause_watch';

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

export function deriveDecision(
  record: JobRecord,
  allJobs?: readonly JobRecord[],
): DerivedDecision {
  const decision = deriveBaseDecision(record);
  const companyWarning =
    allJobs === undefined ? undefined : deriveCompanyWarning(record, allJobs);

  return companyWarning === undefined ? decision : { ...decision, companyWarning };
}

export function normalizeCompanyName(company?: string): string {
  return (company ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function deriveCompanyWarning(
  currentJob: JobRecord,
  allJobs: readonly JobRecord[],
): string | undefined {
  const companyName = normalizeCompanyName(currentJob.company);
  if (companyName === '') {
    return undefined;
  }

  const sameCompanyJobs = allJobs.filter(
    (job) =>
      job.id !== currentJob.id &&
      normalizeCompanyName(job.company) === companyName,
  );
  if (sameCompanyJobs.length === 0) {
    return undefined;
  }

  const hasReplyOrInterview = sameCompanyJobs.some(
    (job) => job.communicationStatus === 'replied' || job.communicationStatus === 'interviewing',
  );
  if (hasReplyOrInterview) {
    return WARNING_EXISTING_REPLY_OR_INTERVIEW;
  }

  const currentStrategy = deriveBaseDecision(currentJob).strategy;
  const hasOtherMainAttack = sameCompanyJobs.some((job) => {
    const statusIsActive = job.communicationStatus !== 'closed' && job.communicationStatus !== 'rejected';
    return statusIsActive && deriveBaseDecision(job).strategy === 'main_attack';
  });
  if (hasOtherMainAttack && currentStrategy !== 'main_attack') {
    return WARNING_EXISTING_MAIN_ATTACK;
  }

  const coldCount = sameCompanyJobs.filter(
    (job) =>
      job.communicationStatus === 'greeted_unread' ||
      job.communicationStatus === 'greeted_read_no_reply',
  ).length;
  return coldCount >= 2 ? WARNING_MULTIPLE_COLD_OPPORTUNITIES : undefined;
}

function deriveBaseDecision(record: JobRecord): DerivedDecision {
  switch (record.communicationStatus) {
    case 'closed':
    case 'rejected':
      return {
        strategy: 'cut_loss',
        nextAction: null,
        stopLoss: false,
        scenario: 'premium_but_cold_closing',
      };

    case 'replied':
      return {
        strategy: 'main_attack',
        nextAction: 'continue_conversation',
        stopLoss: false,
        scenario: 'hr_reply_bridge',
      };

    case 'interviewing':
      return {
        strategy: 'main_attack',
        nextAction: 'prepare_interview',
        stopLoss: false,
        scenario: 'hr_reply_bridge',
      };

    case 'paused':
      return {
        strategy: 'cautious_watch',
        nextAction: 'pause_watch',
        stopLoss: false,
        scenario: 'first_greeting',
      };

    case 'not_contacted':
    case 'greeted_unread':
    case 'greeted_read_no_reply':
      break;

    default: {
      const exhaustive: never = record.communicationStatus;
      return exhaustive;
    }
  }

  const advice = record.report?.applyAdvice ?? '';
  if (advice === '') {
    return emptyReportFallback();
  }

  if (record.communicationStatus === 'not_contacted') {
    return decisionForNewContact(record, advice);
  }

  return decisionForFollowup(record);
}

function emptyReportFallback(): DerivedDecision {
  return {
    strategy: 'cautious_watch',
    nextAction: 'wait',
    stopLoss: false,
    scenario: 'first_greeting',
  };
}

function decisionForNewContact(record: JobRecord, advice: ApplyAdvice): DerivedDecision {
  if (HIGH_MATCH_ADVICES.has(advice)) {
    return {
      strategy: 'main_attack',
      nextAction: 'send_greeting',
      stopLoss: false,
      scenario: 'first_greeting',
    };
  }

  if (record.highValueSignal === true) {
    return {
      strategy: 'low_cost_probe',
      nextAction: 'send_greeting',
      stopLoss: false,
      scenario: 'high_salary_low_match_probe',
    };
  }

  return {
    strategy: 'cautious_watch',
    nextAction: 'wait',
    stopLoss: false,
    scenario: 'first_greeting',
  };
}

function decisionForFollowup(record: JobRecord): DerivedDecision {
  if (record.followupCount >= MAX_FOLLOWUPS) {
    return {
      strategy: 'cut_loss',
      nextAction: 'close_opportunity',
      stopLoss: true,
      scenario: 'premium_but_cold_closing',
    };
  }

  const cooledDown = isPastFollowupCooldown(record);

  if (record.communicationStatus === 'greeted_unread') {
    if (!cooledDown) {
      return waitForFollowup();
    }

    if (record.followupCount === 0) {
      return {
        strategy: activeFollowupStrategy(record),
        nextAction: 'follow_up_once',
        stopLoss: false,
        scenario: 'second_followup',
      };
    }
  }

  if (record.communicationStatus === 'greeted_read_no_reply' && record.followupCount === 0) {
    return {
      strategy: activeFollowupStrategy(record),
      nextAction: 'follow_up_with_new_angle',
      stopLoss: false,
      scenario: 'second_followup',
    };
  }

  if (record.followupCount === 1 && cooledDown) {
    return {
      strategy: activeFollowupStrategy(record),
      nextAction: 'follow_up_with_new_angle',
      stopLoss: false,
      scenario: 'final_unread_followup',
    };
  }

  return waitForFollowup();
}

function waitForFollowup(): DerivedDecision {
  return {
    strategy: 'cautious_watch',
    nextAction: 'wait',
    stopLoss: false,
    scenario: 'second_followup',
  };
}

function activeFollowupStrategy(record: JobRecord): StrategyType {
  const advice = record.report?.applyAdvice ?? '';
  if (advice !== '' && HIGH_MATCH_ADVICES.has(advice)) {
    return 'main_attack';
  }
  if (record.highValueSignal === true) {
    return 'low_cost_probe';
  }
  return 'cautious_watch';
}

function isPastFollowupCooldown(record: JobRecord): boolean {
  const lastActionAt = record.lastFollowupAt ?? record.lastGreetedAt;
  if (typeof lastActionAt !== 'number' || !Number.isFinite(lastActionAt)) {
    return false;
  }

  return Date.now() - lastActionAt >= FOLLOWUP_COOLDOWN_DAYS * MS_PER_DAY;
}
