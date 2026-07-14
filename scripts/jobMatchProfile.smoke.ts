import assert from 'node:assert/strict';
import {
  addJobMatchProfileProposal,
  createEmptyJobMatchProfileState,
  createManualJobMatchProfileDraft,
  decideJobMatchProfileProposal,
  getActiveJobMatchProfileVersion,
} from '../src/domain/job-match-profile';

const draft = createManualJobMatchProfileDraft({
  resumeText: 'Vue / TypeScript 前端经验',
  projectExperience: '数据平台与 AI 应用项目',
  targetCity: '苏州',
  targetRole: '产品型前端 / AI 应用工程师',
  expectedSalary: '16-20K',
  weaknessNote: '学历门槛需要验证',
});

assert.equal(draft.global.scope, 'global');
assert.equal(draft.suzhou.scope, 'suzhou');
assert.equal(draft.wuxi.scope, 'wuxi');
assert.equal(draft.shanghai.scope, 'shanghai');
assert.equal(draft.hangzhou.scope, 'hangzhou');
assert.match(draft.suzhou.focus.salaryRange, /本城市独立证据/);

const proposed = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
  id: 'smoke-proposal',
  source: 'manual',
  draft,
  createdAt: 100,
}).state;
assert.equal(proposed.activeVersionId, null);
assert.equal(proposed.versions.length, 0);

const accepted = decideJobMatchProfileProposal(proposed, {
  proposalId: 'smoke-proposal',
  action: 'accept',
  versionId: 'smoke-version',
  now: 200,
});
assert.equal(getActiveJobMatchProfileVersion(accepted)?.id, 'smoke-version');
assert.equal(accepted.proposals[0]?.status, 'accepted');

console.log('JOB_MATCH_PROFILE_SMOKE_PASS');
