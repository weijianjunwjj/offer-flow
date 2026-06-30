import type { DeriveDecisionInput } from '../spec/derive-decision.schema';

const STATUSES: DeriveDecisionInput['communicationStatus'][] = [
  'not_contacted',
  'greeted_unread',
  'greeted_read_no_reply',
  'replied',
  'interviewing',
  'paused',
  'closed',
  'rejected',
];

const REPORT_SCORES: Array<NonNullable<DeriveDecisionInput['reportScore']>> = [
  'high',
  'medium',
  'low',
  'missing',
];

const NOW = '2026-06-30T10:00:00+08:00';
const OLD = '2026-06-26T10:00:00+08:00';
const RECENT = '2026-06-29T10:00:00+08:00';

export function buildDifferentialMatrix(): DeriveDecisionInput[] {
  const matrix: DeriveDecisionInput[] = [];

  for (const communicationStatus of STATUSES) {
    for (const followupCount of [0, 1, 2]) {
      for (const highValueSignal of [false, true]) {
        for (const reportScore of REPORT_SCORES) {
          matrix.push({
            communicationStatus,
            followupCount,
            highValueSignal,
            reportScore,
            now: NOW,
          });

          matrix.push({
            communicationStatus,
            followupCount,
            lastGreetedAt: OLD,
            highValueSignal,
            reportScore,
            now: NOW,
          });

          matrix.push({
            communicationStatus,
            followupCount,
            lastGreetedAt: RECENT,
            highValueSignal,
            reportScore,
            now: NOW,
          });

          matrix.push({
            communicationStatus,
            followupCount,
            lastFollowupAt: OLD,
            highValueSignal,
            reportScore,
            now: NOW,
          });
        }
      }
    }
  }

  return matrix;
}
