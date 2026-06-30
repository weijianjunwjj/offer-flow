import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db';
import { applyLocalStorageBackup, parseLocalStorageBackup } from '../server/importLocalStorage';
import { initSchema } from '../server/schema';
import { JobRepository } from '../server/repositories/jobRepository';
import { ProfileRepository } from '../server/repositories/profileRepository';
import type { JobRecord, JobSeekerProfile } from '../src/storage';
import { emptyCompanyInput } from '../src/storage';

function profile(targetRole: string): JobSeekerProfile {
  return {
    resumeText: 'resume',
    projectExperience: 'project',
    targetCity: '苏州',
    targetRole,
    expectedSalary: '20K',
    acceptOutsourcing: false,
    acceptOvertime: false,
    jobSearchFocus: 'stability',
    weaknessNote: '',
  };
}

function job(id: string, company: string): JobRecord {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    company,
    role: '前端',
    city: '上海',
    salaryRange: '20-30K',
    jdText: 'JD',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: null,
    matchScore: '80%',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'not_contacted',
    followupCount: 0,
    highValueSignal: false,
  };
}

const backup = {
  'offerpilot:profile': JSON.stringify(profile('legacy')),
  'offerflow:profile': JSON.stringify(profile('current')),
  'offerpilot:job:legacy-job': JSON.stringify(job('legacy-job', 'Legacy 公司')),
  'offerflow:job:current-job': JSON.stringify(job('current-job', 'Current 公司')),
  'offerpilot:job:same-job': JSON.stringify(job('same-job', 'Legacy Same 公司')),
  'offerflow:job:same-job': JSON.stringify(job('same-job', 'Current Same 公司')),
  'offerflow:job:bad': '{ bad json',
  PASSWORD: 'secret',
  token: 'secret',
  __tea_sdk_test: 'x',
  __VUE_DEVTOOLS_GLOBAL_HOOK__: 'x',
  i18nextLng: 'zh',
  'other:key': 'ignored',
};

const preview = parseLocalStorageBackup(backup).summary;
assert.equal(preview.profileCount, 1);
assert.equal(preview.jobCount, 3);
assert.equal(preview.ignoredKeyCount, 6);
assert.equal(preview.parseErrorCount, 1);
assert.equal(preview.warnings.length, 1);
assert.equal(preview.imported, false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-import-'));
process.env.OFFERFLOW_DB_PATH = path.join(tempDir, 'offerflow.sqlite3');
const db = openDb();
try {
  initSchema(db);
  const result = applyLocalStorageBackup(db, backup, 'fixture');
  assert.equal(result.profileCount, 1);
  assert.equal(result.jobCount, 3);
  assert.equal(result.ignoredKeyCount, 6);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.imported, true);

  const savedProfile = new ProfileRepository(db).get();
  assert.equal(savedProfile?.targetRole, 'current');

  const jobs = new JobRepository(db).list();
  assert.equal(jobs.length, 3);
  assert.equal(jobs.find((item) => item.id === 'same-job')?.company, 'Current Same 公司');
  assert.ok(jobs.find((item) => item.id === 'legacy-job'));
  assert.ok(jobs.find((item) => item.id === 'current-job'));

  console.log('importBackup.selftest: passed');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
