export type CommunicationStatus =
  | 'not_contacted'
  | 'greeted_unread'
  | 'greeted_read_no_reply'
  | 'replied'
  | 'interviewing'
  | 'paused'
  | 'closed'
  | 'rejected';

export type ReportScore = 'high' | 'medium' | 'low' | 'missing';

export interface DeriveDecisionInput {
  communicationStatus: CommunicationStatus;
  followupCount: number;
  lastGreetedAt?: string;
  lastFollowupAt?: string;
  highValueSignal: boolean;
  reportScore?: ReportScore;
  now: string;
}

export interface DeriveDecisionOutput {
  strategy: string;
  nextAction: string | null;
  stopLoss: string;
  scenario: string;
  companyWarning?: string;
}

export interface DeriveDecisionCase {
  id: string;
  description?: string;
  when: DeriveDecisionInput;
  then: DeriveDecisionOutput;
}

export interface DeriveDecisionSpec {
  rule: 'deriveDecision';
  version: 'v0.5.0';
  constants: {
    FOLLOWUP_COOLDOWN_DAYS: 3;
    MAX_FOLLOWUPS: 2;
  };
  cases: DeriveDecisionCase[];
}

const COMMUNICATION_STATUSES: ReadonlySet<string> = new Set([
  'not_contacted',
  'greeted_unread',
  'greeted_read_no_reply',
  'replied',
  'interviewing',
  'paused',
  'closed',
  'rejected',
]);

const REPORT_SCORES: ReadonlySet<string> = new Set(['high', 'medium', 'low', 'missing']);

export function validateDeriveDecisionSpec(spec: DeriveDecisionSpec): string[] {
  const errors: string[] = [];

  if (spec.rule !== 'deriveDecision') {
    errors.push('rule must be deriveDecision');
  }
  if (spec.version !== 'v0.5.0') {
    errors.push('version must be v0.5.0');
  }
  if (spec.constants.FOLLOWUP_COOLDOWN_DAYS !== 3) {
    errors.push('FOLLOWUP_COOLDOWN_DAYS must be 3');
  }
  if (spec.constants.MAX_FOLLOWUPS !== 2) {
    errors.push('MAX_FOLLOWUPS must be 2');
  }
  if (!Array.isArray(spec.cases) || spec.cases.length < 14) {
    errors.push('cases must contain at least 14 examples');
  }

  const ids = new Set<string>();
  for (const testCase of spec.cases) {
    if (ids.has(testCase.id)) {
      errors.push(`duplicate case id: ${testCase.id}`);
    }
    ids.add(testCase.id);

    if (!COMMUNICATION_STATUSES.has(testCase.when.communicationStatus)) {
      errors.push(`${testCase.id}: invalid communicationStatus`);
    }
    if (!Number.isInteger(testCase.when.followupCount) || testCase.when.followupCount < 0) {
      errors.push(`${testCase.id}: followupCount must be a non-negative integer`);
    }
    if (typeof testCase.when.highValueSignal !== 'boolean') {
      errors.push(`${testCase.id}: highValueSignal must be boolean`);
    }
    if (
      testCase.when.reportScore !== undefined &&
      !REPORT_SCORES.has(testCase.when.reportScore)
    ) {
      errors.push(`${testCase.id}: invalid reportScore`);
    }
    if (!Number.isFinite(Date.parse(testCase.when.now))) {
      errors.push(`${testCase.id}: now must be parseable`);
    }
    if (
      testCase.when.lastGreetedAt !== undefined &&
      !Number.isFinite(Date.parse(testCase.when.lastGreetedAt))
    ) {
      errors.push(`${testCase.id}: lastGreetedAt must be parseable`);
    }
    if (
      testCase.when.lastFollowupAt !== undefined &&
      !Number.isFinite(Date.parse(testCase.when.lastFollowupAt))
    ) {
      errors.push(`${testCase.id}: lastFollowupAt must be parseable`);
    }
  }

  return errors;
}
