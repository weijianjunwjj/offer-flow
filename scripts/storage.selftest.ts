// Step 0 self-test. Runs in Node via the in-memory driver.
// Verifies: save / read / update / delete for both global config and job records.

import { createStores, MemoryStorageDriver } from '../src/storage';
import type { JobSeekerProfile, JobRecord } from '../src/storage';
import {
  LEGACY_JOB_PREFIX,
  LEGACY_PROFILE_KEY,
  PROFILE_KEY,
  isJobKey,
  jobKey,
} from '../src/storage';

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

const driver = new MemoryStorageDriver();
const { config, jobs } = createStores(driver);

function jobKeyCount(): number {
  return driver.keys().filter(isJobKey).length;
}

function profileKeyCount(): number {
  return driver.keys().filter((k) => k === PROFILE_KEY).length;
}

// --------------------------------------------------------------------------
section('Legacy namespace migration');

const legacyDriver = new MemoryStorageDriver();
const legacyProfile: JobSeekerProfile = {
  resumeText: 'legacy resume',
  projectExperience: 'legacy project',
  targetCity: 'Shanghai',
  targetRole: 'FE',
  expectedSalary: '20K',
  acceptOutsourcing: false,
  acceptOvertime: false,
  jobSearchFocus: 'stability',
  weaknessNote: '',
};
const legacyJobId = 'legacy-job';

legacyDriver.setItem(LEGACY_PROFILE_KEY, JSON.stringify(legacyProfile));
legacyDriver.setItem(
  `${LEGACY_JOB_PREFIX}${legacyJobId}`,
  JSON.stringify({
    id: legacyJobId,
    createdAt: 1,
    updatedAt: 1,
    company: 'Legacy Company',
    role: 'FE',
    city: 'Shanghai',
    salaryRange: '20K',
    jdText: 'legacy jd',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: null,
    matchScore: '',
    contactStatus: 'not_contacted',
    contactStatusUpdatedAt: 1,
  }),
);

const legacyStores = createStores(legacyDriver);
check(
  'legacy profile migrates to current key',
  legacyStores.config.getProfile()?.targetCity === 'Shanghai',
);
check(
  'legacy job migrates to current key',
  legacyStores.jobs.getJob(legacyJobId)?.company === 'Legacy Company',
);
check('legacy profile key is retained', legacyDriver.getItem(LEGACY_PROFILE_KEY) !== null);
check(
  'legacy job key is retained',
  legacyDriver.getItem(`${LEGACY_JOB_PREFIX}${legacyJobId}`) !== null,
);

// --------------------------------------------------------------------------
section('Global profile CRUD');

check('empty store returns null profile', config.getProfile() === null);

const profile: JobSeekerProfile = {
  resumeText: '7 nian qianduan, Vue 2/3 + TS',
  projectExperience: 'EBI zhonghoutai weiqianduan pingtai',
  targetCity: 'Suzhou',
  targetRole: 'Senior FE / FE Architect',
  expectedSalary: '17-22K',
  acceptOutsourcing: false,
  acceptOvertime: true,
  jobSearchFocus: 'growth',
  weaknessNote: 'adult bachelor 2026.06',
};

config.saveProfile(profile);
const readProfile = config.getProfile();
check('profile reads back after save', readProfile?.targetCity === 'Suzhou');
check('boolean field round-trips', readProfile?.acceptOutsourcing === false);
check('literal-union field round-trips', readProfile?.jobSearchFocus === 'growth');
check('exactly one profile key after save', profileKeyCount() === 1);

config.saveProfile({ ...profile, expectedSalary: '18-24K' });
check('overwrite updates field', config.getProfile()?.expectedSalary === '18-24K');
check('overwrite stays single key (no duplication)', profileKeyCount() === 1);

config.clearProfile();
check('profile cleared returns null', config.getProfile() === null);
check('profile key removed', profileKeyCount() === 0);

// --------------------------------------------------------------------------
section('Job record CRUD');

const jobA = jobs.createJob({
  company: 'Company A',
  role: 'Senior FE',
  city: 'Suzhou',
  salaryRange: '18-22K',
  jdText: 'Vue3 + TS zhonghoutai',
});
const jobB = jobs.createJob({
  company: 'Company B',
  role: 'FE Architect',
  city: 'Hangzhou',
  salaryRange: '25-30K',
  jdText: 'React + lowcode',
});

check('createJob assigns an id', jobA.id.length > 0);
check('two jobs get different ids', jobA.id !== jobB.id);
check('new job defaults communicationStatus', jobA.communicationStatus === 'not_contacted');
check('new job defaults followupCount', jobA.followupCount === 0);
check('new job defaults highValueSignal false', jobA.highValueSignal === false);
check('new job leaves lastGreetedAt empty', jobA.lastGreetedAt === undefined);
check(
  'new job does not persist legacy contactStatus',
  !JSON.parse(driver.getItem(jobKey(jobA.id)) ?? '{}').hasOwnProperty('contactStatus'),
);
check('new job defaults parseStatus', jobA.parseStatus === 'none');
check('new job has empty aiRawResult', jobA.aiRawResult === '');
check('new job has null report', jobA.report === null);
check('one storage key per job', jobKeyCount() === 2);

const readA = jobs.getJob(jobA.id);
check('job reads back by id', readA?.company === 'Company A');
check('getJob on missing id returns null', jobs.getJob('no-such-id') === null);

check('listJobs returns both', jobs.listJobs().length === 2);

const updatedA = jobs.updateJob(jobA.id, {
  communicationStatus: 'greeted_unread',
  lastGreetedAt: 1_700_000_000_000,
  followupCount: 1,
  lastFollowupAt: 1_700_086_400_000,
  lastCommunicationNote: 'HR has not read the greeting yet.',
  highValueSignal: true,
  strategyOverride: 'low_cost_probe',
  draftMessageText: '你好，我看这个岗位和我的前端经历比较匹配，想进一步了解。',
  aiRawResult: 'external AI raw text...',
  parseStatus: 'unparsed',
});
check('update changes communicationStatus', updatedA.communicationStatus === 'greeted_unread');
check('update saves lastGreetedAt', updatedA.lastGreetedAt === 1_700_000_000_000);
check('update saves followupCount', updatedA.followupCount === 1);
check('update saves lastFollowupAt', updatedA.lastFollowupAt === 1_700_086_400_000);
check('update saves lastCommunicationNote', updatedA.lastCommunicationNote === 'HR has not read the greeting yet.');
check('update saves highValueSignal', updatedA.highValueSignal === true);
check('update saves strategyOverride', updatedA.strategyOverride === 'low_cost_probe');
check('update saves draftMessageText', updatedA.draftMessageText?.includes('前端经历') === true);
check('update preserves id', updatedA.id === jobA.id);
check('update preserves createdAt', updatedA.createdAt === jobA.createdAt);
check('update sets updatedAt (>= created)', updatedA.updatedAt >= jobA.createdAt);
check('raw AI text persisted on update', jobs.getJob(jobA.id)?.aiRawResult === 'external AI raw text...');
check('update did not create extra keys', jobKeyCount() === 2);
check('updating a missing job throws', mustThrow(() => jobs.updateJob('nope', { city: 'x' })));

const deleted = jobs.deleteJob(jobB.id);
check('deleteJob reports success', deleted === true);
check('deleted job no longer readable', jobs.getJob(jobB.id) === null);
check('listJobs reflects deletion', jobs.listJobs().length === 1);
check('deleting a missing job reports false', jobs.deleteJob('does-not-exist') === false);

// --------------------------------------------------------------------------
section('v0.2 defaults & backward compatibility');

// 用独立 driver / stores，避免影响上面的键计数断言。
const v2Driver = new MemoryStorageDriver();
const v2Stores = createStores(v2Driver);

// 新建岗位带 v0.2 默认值
const freshJob = v2Stores.jobs.createJob({ company: 'C', role: 'FE' });
check('new job companyInput size defaults unknown', freshJob.companyInput.sizeTier === 'unknown');
check(
  'new job companyInput strings empty',
  freshJob.companyInput.staffRange === '' && freshJob.companyInput.commuteTime === '',
);
check('new job companyAssessment is null', freshJob.companyAssessment === null);
check('new job opportunityAnalysis is null', freshJob.opportunityAnalysis === null);

const v01JobBase = {
  createdAt: 2,
  updatedAt: 2,
  company: 'Old Co',
  role: 'FE',
  city: 'Suzhou',
  salaryRange: '20K',
  jdText: 'jd',
  promptText: '',
  aiRawResult: '',
  aiPastedAt: null,
  parseStatus: 'none',
  report: null,
  matchScore: '',
  contactStatus: 'not_contacted',
  contactStatusUpdatedAt: 2,
};

// 旧岗位（完全缺 v0.2/v0.3 字段）：读取自动补默认值、不丢历史字段、不报错
const oldId = 'old-v01-job';
v2Driver.setItem(jobKey(oldId), JSON.stringify({ ...v01JobBase, id: oldId }));
let oldRead: JobRecord | null = null;
check(
  'reading a legacy job does not throw',
  (() => {
    try {
      oldRead = v2Stores.jobs.getJob(oldId);
      return true;
    } catch {
      return false;
    }
  })(),
);
check('legacy job keeps v0.1 fields', oldRead?.company === 'Old Co');
check('legacy job backfills companyInput', oldRead?.companyInput.sizeTier === 'unknown');
check('legacy job backfills companyAssessment null', oldRead?.companyAssessment === null);
check('legacy job backfills opportunityAnalysis null', oldRead?.opportunityAnalysis === null);
check('legacy not_contacted migrates to communicationStatus', oldRead?.communicationStatus === 'not_contacted');
check('legacy job backfills followupCount 0', oldRead?.followupCount === 0);
check('legacy job treats highValueSignal as false', oldRead?.highValueSignal === false);
check('legacy contactStatusUpdatedAt does not become lastGreetedAt', oldRead?.lastGreetedAt === undefined);
check('legacy job appears in listJobs', v2Stores.jobs.listJobs().some((j) => j.id === oldId));

const legacyStatusCases = [
  ['legacy-greeted', 'greeted', 'greeted_unread'],
  ['legacy-replied', 'replied', 'replied'],
  ['legacy-interview', 'interview_scheduled', 'interviewing'],
  ['legacy-rejected', 'rejected', 'rejected'],
  ['legacy-closed', 'closed', 'closed'],
] as const;
for (const [id, contactStatus, communicationStatus] of legacyStatusCases) {
  v2Driver.setItem(jobKey(id), JSON.stringify({ ...v01JobBase, id, contactStatus }));
  check(
    `${contactStatus} migrates to ${communicationStatus}`,
    v2Stores.jobs.getJob(id)?.communicationStatus === communicationStatus,
  );
}

const missingStatusId = 'legacy-missing-status';
const missingStatusJob = { ...v01JobBase, id: missingStatusId };
delete (missingStatusJob as { contactStatus?: unknown }).contactStatus;
v2Driver.setItem(jobKey(missingStatusId), JSON.stringify(missingStatusJob));
check(
  'missing legacy status defaults not_contacted',
  v2Stores.jobs.getJob(missingStatusId)?.communicationStatus === 'not_contacted',
);

// 旧岗位携带「部分」companyInput：保留已有值，仅补缺失字段
const partialId = 'partial-companyinput-job';
v2Driver.setItem(
  jobKey(partialId),
  JSON.stringify({
    ...v01JobBase,
    id: partialId,
    companyInput: { sizeTier: 'medium', staffRange: '100-499人' },
  }),
);
const partialRead = v2Stores.jobs.getJob(partialId);
check(
  'partial companyInput keeps provided values',
  partialRead?.companyInput.sizeTier === 'medium' &&
    partialRead?.companyInput.staffRange === '100-499人',
);
check(
  'partial companyInput fills missing values',
  partialRead?.companyInput.companyType === '' && partialRead?.companyInput.commuteWay === '',
);

// --------------------------------------------------------------------------
section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

function mustThrow(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
