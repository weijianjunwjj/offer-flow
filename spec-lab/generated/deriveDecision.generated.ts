// GENERATED FILE - DO NOT EDIT DIRECTLY

import type {
  DeriveDecisionInput,
  DeriveDecisionOutput,
  ReportScore,
} from '../spec/derive-decision.schema';

export const FOLLOWUP_COOLDOWN_DAYS = 3;
export const MAX_FOLLOWUPS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function deriveDecision(input: DeriveDecisionInput): DeriveDecisionOutput {
  switch (input.communicationStatus) {
    case 'closed':
    case 'rejected':
      return {
        strategy: 'cut_loss',
        nextAction: null,
        stopLoss: 'continue',
        scenario: 'premium_but_cold_closing',
      };

    case 'replied':
      return {
        strategy: 'main_attack',
        nextAction: 'continue_conversation',
        stopLoss: 'continue',
        scenario: 'hr_reply_bridge',
      };

    case 'interviewing':
      return {
        strategy: 'main_attack',
        nextAction: 'prepare_interview',
        stopLoss: 'continue',
        scenario: 'hr_reply_bridge',
      };

    case 'paused':
      return {
        strategy: 'cautious_watch',
        nextAction: 'pause_watch',
        stopLoss: 'continue',
        scenario: 'first_greeting',
      };

    case 'not_contacted':
    case 'greeted_unread':
    case 'greeted_read_no_reply':
      break;

    default: {
      const exhaustive: never = input.communicationStatus;
      return exhaustive;
    }
  }

  if (scoreIsMissing(input.reportScore)) {
    return {
      strategy: 'cautious_watch',
      nextAction: 'wait',
      stopLoss: 'continue',
      scenario: 'first_greeting',
    };
  }

  if (input.communicationStatus === 'not_contacted') {
    return decisionForNewContact(input);
  }

  return decisionForFollowup(input);
}

function decisionForNewContact(input: DeriveDecisionInput): DeriveDecisionOutput {
  if (isHighScore(input.reportScore)) {
    return {
      strategy: 'main_attack',
      nextAction: 'send_greeting',
      stopLoss: 'continue',
      scenario: 'first_greeting',
    };
  }

  if (input.highValueSignal) {
    return {
      strategy: 'low_cost_probe',
      nextAction: 'send_greeting',
      stopLoss: 'continue',
      scenario: 'high_salary_low_match_probe',
    };
  }

  return {
    strategy: 'cautious_watch',
    nextAction: 'wait',
    stopLoss: 'continue',
    scenario: 'first_greeting',
  };
}

function decisionForFollowup(input: DeriveDecisionInput): DeriveDecisionOutput {
  if (input.followupCount >= MAX_FOLLOWUPS) {
    return {
      strategy: 'cut_loss',
      nextAction: 'close_opportunity',
      stopLoss: 'stop',
      scenario: 'premium_but_cold_closing',
    };
  }

  const cooledDown = isPastFollowupCooldown(input);

  if (input.communicationStatus === 'greeted_unread') {
    if (!cooledDown) {
      return waitForFollowup();
    }

    if (input.followupCount === 0) {
      return {
        strategy: activeFollowupStrategy(input),
        nextAction: 'follow_up_once',
        stopLoss: 'continue',
        scenario: 'second_followup',
      };
    }
  }

  if (input.communicationStatus === 'greeted_read_no_reply' && input.followupCount === 0) {
    return {
      strategy: activeFollowupStrategy(input),
      nextAction: 'follow_up_with_new_angle',
      stopLoss: 'continue',
      scenario: input.highValueSignal ? 'follow_up_with_value_angle' : 'follow_up_with_new_angle',
    };
  }

  if (input.followupCount === 1 && cooledDown) {
    return {
      strategy: activeFollowupStrategy(input),
      nextAction: 'follow_up_with_new_angle',
      stopLoss: 'continue',
      scenario: 'final_unread_followup',
    };
  }

  return waitForFollowup();
}

function waitForFollowup(): DeriveDecisionOutput {
  return {
    strategy: 'cautious_watch',
    nextAction: 'wait',
    stopLoss: 'continue',
    scenario: 'second_followup',
  };
}

function activeFollowupStrategy(input: DeriveDecisionInput): string {
  if (isHighScore(input.reportScore)) {
    return 'main_attack';
  }
  if (input.highValueSignal) {
    return 'low_cost_probe';
  }
  return 'cautious_watch';
}

function isPastFollowupCooldown(input: DeriveDecisionInput): boolean {
  const lastActionAt = input.lastFollowupAt ?? input.lastGreetedAt;
  if (lastActionAt === undefined) {
    return false;
  }

  const lastActionMs = Date.parse(lastActionAt);
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(lastActionMs) || !Number.isFinite(nowMs)) {
    return false;
  }

  return nowMs - lastActionMs >= FOLLOWUP_COOLDOWN_DAYS * MS_PER_DAY;
}

function scoreIsMissing(score: ReportScore | undefined): boolean {
  return score === undefined || score === 'missing';
}

function isHighScore(score: ReportScore | undefined): boolean {
  return score === 'high' || score === 'medium';
}
