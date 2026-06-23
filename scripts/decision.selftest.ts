import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  deriveDecision,
  deriveCompanyWarning,
  FOLLOWUP_COOLDOWN_DAYS,
  MAX_FOLLOWUPS,
  normalizeCompanyName,
  type MessageScenario,
} from '../src/decision';
import { buildMessageTemplate } from '../src/app/messageTemplates';
import { emptyCompanyInput } from '../src/storage';
import type { JobRecord } from '../src/storage';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const now = Date.now();
const oldEnough = now - (FOLLOWUP_COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000;
const tooRecent = now - 1 * 24 * 60 * 60 * 1000;

function baseJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1',
    createdAt: 1,
    updatedAt: 1,
    company: 'OfferFlow Test Co',
    role: 'Frontend Engineer',
    city: 'Suzhou',
    salaryRange: '20-30K',
    jdText: 'Vue TypeScript',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: {
      jobType: '',
      keywords: '',
      techStackMatch: '',
      projectMatch: '',
      strengths: '',
      risks: '',
      resumeAdvice: '',
      interviewChecklist: '',
      applyAdvice: 'ok',
      greetingMessage: '',
    },
    matchScore: '',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'not_contacted',
    followupCount: 0,
    highValueSignal: false,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
section('New contact decisions');

let decision = deriveDecision(baseJob());
check('not_contacted + high match -> main_attack', decision.strategy === 'main_attack');
check('not_contacted + high match -> send_greeting', decision.nextAction === 'send_greeting');
check('not_contacted + high match -> first_greeting', decision.scenario === 'first_greeting');

decision = deriveDecision(
  baseJob({
    highValueSignal: true,
    report: {
      ...baseJob().report!,
      applyAdvice: 'skip',
    },
  }),
);
check('highValueSignal triggers low_cost_probe', decision.strategy === 'low_cost_probe');
check('highValueSignal still sends greeting', decision.nextAction === 'send_greeting');
check(
  'highValueSignal uses high_salary_low_match_probe',
  decision.scenario === 'high_salary_low_match_probe',
);

decision = deriveDecision(
  baseJob({
    report: {
      ...baseJob().report!,
      applyAdvice: 'cautious',
    },
  }),
);
check('low/general opportunity waits', decision.strategy === 'cautious_watch');
check('low/general opportunity nextAction wait', decision.nextAction === 'wait');

decision = deriveDecision(baseJob({ report: null }));
check('report null falls back to cautious_watch', decision.strategy === 'cautious_watch');
check('report null falls back to wait', decision.nextAction === 'wait');
check('report null falls back to first_greeting', decision.scenario === 'first_greeting');

decision = deriveDecision(
  baseJob({
    report: {
      ...baseJob().report!,
      applyAdvice: '',
    },
  }),
);
check('empty applyAdvice uses empty report fallback', decision.nextAction === 'wait');

// --------------------------------------------------------------------------
section('Followup count decisions');

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_unread',
    followupCount: 0,
    lastGreetedAt: oldEnough,
  }),
);
check('followupCount 0 after cooldown -> follow_up_once', decision.nextAction === 'follow_up_once');
check('followupCount 0 keeps strategy as main_attack', decision.strategy === 'main_attack');
check('followupCount 0 after cooldown -> second_followup', decision.scenario === 'second_followup');

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_unread',
    followupCount: 0,
    lastGreetedAt: tooRecent,
  }),
);
check('greeted_unread before cooldown -> wait', decision.nextAction === 'wait');

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_read_no_reply',
    followupCount: 0,
    lastGreetedAt: tooRecent,
  }),
);
check('greeted_read_no_reply + followupCount 0 -> new angle', decision.nextAction === 'follow_up_with_new_angle');
check('greeted_read_no_reply + followupCount 0 keeps strategy as main_attack', decision.strategy === 'main_attack');
check('greeted_read_no_reply + followupCount 0 -> second_followup', decision.scenario === 'second_followup');

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_unread',
    followupCount: 1,
    lastFollowupAt: oldEnough,
  }),
);
check('followupCount 1 after cooldown -> new angle', decision.nextAction === 'follow_up_with_new_angle');
check('followupCount 1 keeps strategy as main_attack', decision.strategy === 'main_attack');
check('followupCount 1 triggers final_unread_followup', decision.scenario === 'final_unread_followup');
check('followupCount 1 does not stop loss', decision.stopLoss === false);

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_read_no_reply',
    followupCount: MAX_FOLLOWUPS,
    lastFollowupAt: oldEnough,
  }),
);
check('followupCount >= MAX_FOLLOWUPS -> cut_loss', decision.strategy === 'cut_loss');
check('followupCount >= MAX_FOLLOWUPS -> close_opportunity', decision.nextAction === 'close_opportunity');
check('followupCount >= MAX_FOLLOWUPS -> stopLoss true', decision.stopLoss === true);
check('followupCount >= MAX_FOLLOWUPS -> closing scenario', decision.scenario === 'premium_but_cold_closing');

decision = deriveDecision(
  baseJob({
    communicationStatus: 'greeted_unread',
    followupCount: 0,
  }),
);
check('missing followup timestamp is conservative wait', decision.nextAction === 'wait');

// --------------------------------------------------------------------------
section('Terminal and active statuses');

decision = deriveDecision(baseJob({ communicationStatus: 'closed' }));
check('closed returns nextAction null', decision.nextAction === null);
check('closed does not stop loss', decision.stopLoss === false);

decision = deriveDecision(baseJob({ communicationStatus: 'rejected' }));
check('rejected returns nextAction null', decision.nextAction === null);
check('rejected does not stop loss', decision.stopLoss === false);

decision = deriveDecision(baseJob({ communicationStatus: 'replied' }));
check('replied returns continue_conversation', decision.nextAction === 'continue_conversation');
check('replied uses hr_reply_bridge', decision.scenario === 'hr_reply_bridge');

decision = deriveDecision(baseJob({ communicationStatus: 'interviewing' }));
check('interviewing returns prepare_interview', decision.nextAction === 'prepare_interview');

decision = deriveDecision(baseJob({ communicationStatus: 'paused' }));
check('paused returns pause_watch', decision.nextAction === 'pause_watch');
check('paused does not stop loss', decision.stopLoss === false);

// --------------------------------------------------------------------------
section('Company warnings');

check(
  'normalizeCompanyName trims, lowers and collapses spaces',
  normalizeCompanyName('  OfferFlow   TEST Co  ') === 'offerflow test co',
);
check('normalizeCompanyName empty fallback', normalizeCompanyName('   ') === '');

const currentCompanyJob = baseJob({
  id: 'current',
  company: '星河科技',
  report: {
    ...baseJob().report!,
    applyAdvice: 'cautious',
  },
});
const repliedCompanyJob = baseJob({
  id: 'replied',
  company: ' 星河科技 ',
  communicationStatus: 'replied',
});
const mainAttackCompanyJob = baseJob({
  id: 'main',
  company: '星河科技',
  communicationStatus: 'not_contacted',
  report: {
    ...baseJob().report!,
    applyAdvice: 'ok',
  },
});
const coldCompanyJobA = baseJob({
  id: 'cold-a',
  company: '星河科技',
  communicationStatus: 'greeted_unread',
  report: {
    ...baseJob().report!,
    applyAdvice: 'cautious',
  },
});
const coldCompanyJobB = baseJob({
  id: 'cold-b',
  company: ' 星河科技 ',
  communicationStatus: 'greeted_read_no_reply',
  report: {
    ...baseJob().report!,
    applyAdvice: 'skip',
  },
});
const otherCompanyJob = baseJob({
  id: 'other-company',
  company: '另一家公司',
  communicationStatus: 'replied',
});

check(
  'same company replied/interviewing triggers priority warning',
  deriveCompanyWarning(currentCompanyJob, [currentCompanyJob, repliedCompanyJob])?.includes('已有岗位进入沟通或面试推进') === true,
);
check(
  'same company main attack triggers warning for non-main current job',
  deriveCompanyWarning(currentCompanyJob, [currentCompanyJob, mainAttackCompanyJob])?.includes('已有其他岗位处于主攻推进') === true,
);
check(
  'same company main attack does not warn when current is also main_attack',
  deriveCompanyWarning(
    baseJob({ id: 'current-main', company: '星河科技' }),
    [baseJob({ id: 'current-main', company: '星河科技' }), mainAttackCompanyJob],
  ) === undefined,
);
check(
  'multiple cold opportunities trigger warning',
  deriveCompanyWarning(currentCompanyJob, [currentCompanyJob, coldCompanyJobA, coldCompanyJobB])?.includes('已有多个岗位未读或未回') === true,
);
check(
  'reply warning wins over main attack and cold warnings',
  deriveCompanyWarning(currentCompanyJob, [
    currentCompanyJob,
    repliedCompanyJob,
    mainAttackCompanyJob,
    coldCompanyJobA,
    coldCompanyJobB,
  ])?.includes('已有岗位进入沟通或面试推进') === true,
);
check(
  'different company does not trigger warning',
  deriveCompanyWarning(currentCompanyJob, [currentCompanyJob, otherCompanyJob]) === undefined,
);
check(
  'current job itself does not trigger company warning',
  deriveCompanyWarning(baseJob({ id: 'self', company: '星河科技', communicationStatus: 'replied' }), [
    baseJob({ id: 'self', company: '星河科技', communicationStatus: 'replied' }),
  ]) === undefined,
);
check(
  'deriveDecision returns companyWarning when allJobs provided',
  deriveDecision(currentCompanyJob, [currentCompanyJob, repliedCompanyJob]).companyWarning?.includes('已有岗位进入沟通或面试推进') === true,
);

// --------------------------------------------------------------------------
section('Message templates');

const scenarios: MessageScenario[] = [
  'first_greeting',
  'second_followup',
  'final_unread_followup',
  'high_salary_low_match_probe',
  'premium_but_cold_closing',
  'hr_reply_bridge',
];
const richJob = baseJob({
  company: '星河科技',
  role: '前端平台工程师',
  salaryRange: '25-35K',
  report: {
    ...baseJob().report!,
    techStackMatch: 'Vue、TypeScript 和中后台工程化',
    projectMatch: '复杂表单和数据平台经验',
    strengths: '能独立推进前端工程质量',
  },
  companyInput: {
    ...emptyCompanyInput(),
    opportunityNote: '平台方向和长期成长空间',
  },
});
const emptyTemplateJob = baseJob({
  company: '',
  role: '',
  salaryRange: '',
  jdText: '',
  report: null,
});
const forbiddenPlaceholderPattern = /\b(undefined|null|NaN)\b/;
const generatedTemplates = scenarios.map((scenario) => buildMessageTemplate(scenario, richJob));

check('all MessageScenario values have templates', generatedTemplates.every((text) => text.length > 0));
check(
  'templates safely fill role variable',
  buildMessageTemplate('first_greeting', richJob).includes('前端平台工程师'),
);
check(
  'templates safely fill salary/value probe variables',
  buildMessageTemplate('high_salary_low_match_probe', richJob).includes('25-35K'),
);
check(
  'templates are short enough for Boss greeting',
  generatedTemplates.every((text) => text.length <= 95),
);
check(
  'empty record templates do not leak undefined/null/NaN',
  scenarios.every((scenario) => !forbiddenPlaceholderPattern.test(buildMessageTemplate(scenario, emptyTemplateJob))),
);

// --------------------------------------------------------------------------
section('Purity guard');

let storageCalls = 0;
let networkCalls = 0;
const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => {
      storageCalls += 1;
      return null;
    },
    setItem: () => {
      storageCalls += 1;
    },
    removeItem: () => {
      storageCalls += 1;
    },
  },
});
const globalWithFetch = globalThis as typeof globalThis & { fetch?: typeof fetch };
const originalFetch = globalWithFetch.fetch;
globalWithFetch.fetch = (async () => {
  networkCalls += 1;
  return new Response();
}) as typeof fetch;

deriveDecision(baseJob());
check('deriveDecision does not touch local storage API', storageCalls === 0);
check('deriveDecision does not call fetch', networkCalls === 0);

if (localStorageDescriptor) {
  Object.defineProperty(globalThis, 'localStorage', localStorageDescriptor);
} else {
  Reflect.deleteProperty(globalThis, 'localStorage');
}
if (originalFetch) {
  globalWithFetch.fetch = originalFetch;
} else {
  Reflect.deleteProperty(globalWithFetch, 'fetch');
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const decisionSource = readFileSync(resolve(scriptDir, '../src/decision/deriveDecision.ts'), 'utf8');
check('decision source has no local storage token', !decisionSource.includes('localStorage'));
check('decision source has no fetch call token', !decisionSource.includes('fetch('));
check('decision source has no XMLHttpRequest token', !decisionSource.includes('XMLHttpRequest'));
check('decision source has no axios token', !decisionSource.includes('axios'));

// --------------------------------------------------------------------------
section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
