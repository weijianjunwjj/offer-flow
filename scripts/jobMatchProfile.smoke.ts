import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db';
import { initSchema } from '../server/schema';
import { ProfileRepository } from '../server/repositories/profileRepository';
import { JobMatchProfileService } from '../server/job-match-profile/service';
import type { JobMatchProfileAiProvider } from '../server/job-match-profile/aiProvider';
import { JobMatchProfileError } from '../server/job-match-profile/errors';
import type { JobMatchProfileDraft } from '../src/domain/job-match-profile';
import { makeJobMatchProfileDraftFixture } from '../src/domain/job-match-profile/testFixtures';
import type { JobSeekerProfile } from '../src/storage';

// 岗位匹配画像 · G1 冒烟脚本
// 直接驱动本地模块化服务，走内存 SQLite，不调用真实 AI，不写真实库。

function baseProfile(): JobSeekerProfile {
  return {
    resumeText: 'Vue / TypeScript / Node.js 全栈与 AI 应用工程经验',
    projectExperience: '复杂 B 端产品与 AI 应用工程化项目',
    targetCity: '苏州',
    targetRole: 'AI 应用前端工程师',
    expectedSalary: '25-35K',
    acceptOutsourcing: false,
    acceptOvertime: true,
    jobSearchFocus: 'growth',
    weaknessNote: '大型成熟 AI 项目生产证明仍不足',
  };
}

function makeDraft(northStar: string): JobMatchProfileDraft {
  return { ...makeJobMatchProfileDraftFixture(), northStarPositioning: northStar };
}

function latestProposalId(proposals: Array<{ id: string }>): string {
  const last = proposals[proposals.length - 1];
  assert.ok(last, '应存在至少一个提案');
  return last.id;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-jmp-smoke-'));
const db = openDb(path.join(tempDir, 'smoke.sqlite3'));

try {
  initSchema(db, { targetVersion: 2 });
  new ProfileRepository(db).save(baseProfile());

  let clock = 1_000;
  let seq = 0;
  const aiProvider: JobMatchProfileAiProvider = {
    isConfigured: () => true,
    modelName: () => 'smoke-fake-model',
    generate: async () => ({
      rawText: JSON.stringify(makeDraft('AI 建议：AI 应用工程 / 产品型前端方向')),
      model: 'smoke-fake-model',
    }),
  };
  const service = new JobMatchProfileService(db, {
    now: () => (clock += 10),
    createId: () => `jmp-${(seq += 1)}`,
    aiProvider,
  });

  // 1. 空状态
  const empty = service.getProfile();
  assert.equal(empty.state.stateVersion, 0);
  assert.equal(empty.activeVersion, null);
  assert.equal(empty.state.proposals.length, 0);

  // 2. 手工 proposal，未确认不影响 active version
  const manualView = service.createManualProposal({
    idempotencyKey: 'manual-1',
    expectedProfileStateVersion: empty.state.stateVersion,
    payload: makeDraft('手工草案：AI 应用全栈工程师'),
  });
  assert.equal(manualView.state.proposals.length, 1);
  assert.equal(manualView.state.proposals[0]?.status, 'proposed');
  assert.equal(manualView.activeVersion, null, '未确认 proposal 不得产生正式版本');

  // 3. 接受 proposal 创建新版本 V1
  const manualId = latestProposalId(manualView.state.proposals);
  const v1View = service.acceptProposal(manualId, {
    idempotencyKey: 'accept-1',
    expectedProfileStateVersion: manualView.state.stateVersion,
    decisionNote: '确认为正式画像',
  });
  assert.ok(v1View.activeVersion, '接受后应存在 active version');
  assert.equal(v1View.activeVersion?.version, 1);
  assert.equal(v1View.state.versions.length, 1);
  const v1Id = v1View.activeVersion?.id ?? '';
  const acceptedProposal = v1View.state.proposals.find((p) => p.id === manualId);
  assert.equal(acceptedProposal?.status, 'accepted');

  // 4. AI proposal 使用严格 Draft Schema（fake provider，不调用真实模型）
  const aiView = await service.generateProposal({
    idempotencyKey: 'ai-1',
    expectedProfileStateVersion: v1View.state.stateVersion,
  });
  const aiProposal = aiView.state.proposals.find((p) => p.generatedBy === 'ai');
  assert.ok(aiProposal, '应生成一个 AI 提案');
  assert.equal(aiProposal?.status, 'proposed');
  assert.equal(aiView.activeVersion?.id, v1Id, 'AI 提案未确认前不得改变正式版本');

  // 5. 修改后接受，保存修改后的正式内容 → V2
  const modified = makeDraft('修改后接受：复杂产品技术负责人路线');
  const v2View = service.acceptProposal(aiProposal!.id, {
    idempotencyKey: 'accept-2',
    expectedProfileStateVersion: aiView.state.stateVersion,
    decisionNote: '修改后确认',
    modifiedPayload: modified,
  });
  assert.equal(v2View.activeVersion?.version, 2);
  assert.equal(v2View.activeVersion?.northStarPositioning, '修改后接受：复杂产品技术负责人路线');
  const modifiedProposal = v2View.state.proposals.find((p) => p.id === aiProposal!.id);
  assert.equal(modifiedProposal?.status, 'modified_and_accepted');

  // 6. 已激活版本不可原地修改：V1 内容保持不变
  const v1Snapshot = v2View.state.versions.find((v) => v.id === v1Id);
  assert.equal(v1Snapshot?.northStarPositioning, '手工草案：AI 应用全栈工程师');
  assert.equal(v1Snapshot?.status, 'archived');

  // 7. 版本历史切换：切回 V1
  const switched = service.activateVersion(v1Id, {
    idempotencyKey: 'activate-1',
    expectedProfileStateVersion: v2View.state.stateVersion,
    confirmed: true,
  });
  assert.equal(switched.state.activeVersionId, v1Id);
  assert.equal(switched.activeVersion?.version, 1);

  // 8. 拒绝、稍后处理不影响正式画像
  const rejectSeed = service.createManualProposal({
    idempotencyKey: 'manual-reject',
    expectedProfileStateVersion: switched.state.stateVersion,
    payload: makeDraft('待拒绝草案'),
  });
  const rejected = service.rejectProposal(latestProposalId(rejectSeed.state.proposals), {
    idempotencyKey: 'reject-1',
    expectedProfileStateVersion: rejectSeed.state.stateVersion,
    decisionNote: '不采纳',
  });
  assert.equal(rejected.activeVersion?.id, v1Id, '拒绝不得改变正式画像');
  assert.ok(rejected.state.proposals.some((p) => p.status === 'rejected'));

  const deferSeed = service.createManualProposal({
    idempotencyKey: 'manual-defer',
    expectedProfileStateVersion: rejected.state.stateVersion,
    payload: makeDraft('待稍后处理草案'),
  });
  const deferred = service.deferProposal(latestProposalId(deferSeed.state.proposals), {
    idempotencyKey: 'defer-1',
    expectedProfileStateVersion: deferSeed.state.stateVersion,
    decisionNote: '稍后再看',
  });
  assert.equal(deferred.activeVersion?.id, v1Id, '稍后处理不得改变正式画像');
  assert.ok(deferred.state.proposals.some((p) => p.status === 'deferred'));

  // 9. 乐观并发冲突：使用过期 stateVersion
  assert.throws(
    () => service.createManualProposal({
      idempotencyKey: 'stale-1',
      expectedProfileStateVersion: 0,
      payload: makeDraft('并发冲突草案'),
    }),
    (error: unknown) => error instanceof JobMatchProfileError && error.code === 'PROFILE_VERSION_CONFLICT',
  );

  // 10. 请求幂等：相同幂等键 + 相同请求，重复调用不产生新提案
  const idemInput = {
    idempotencyKey: 'idem-1',
    expectedProfileStateVersion: deferred.state.stateVersion,
    payload: makeDraft('幂等测试草案'),
  };
  const idem1 = service.createManualProposal(idemInput);
  const idem2 = service.createManualProposal(idemInput);
  assert.equal(idem1.state.proposals.length, idem2.state.proposals.length, '幂等重放不得新增提案');

  // 11. 四城市不串数据：借用证据显示来源、原因、权重（降权）与不适用范围
  const active = switched.activeVersion;
  assert.ok(active);
  const wuxi = active!.cityProfiles.find((c) => c.city === 'wuxi');
  assert.ok(wuxi, '应存在无锡城市画像');
  assert.equal(wuxi!.borrowedEvidence.length, 1);
  assert.equal(wuxi!.borrowedEvidence[0]?.sourceCity, 'suzhou');
  assert.ok(wuxi!.borrowedEvidence[0]?.reason.length > 0);
  assert.ok(wuxi!.borrowedEvidence[0]?.discountNote.length > 0);
  assert.ok(wuxi!.borrowedEvidence[0]?.notApplicableTo.includes('薪资'));
  const cities = active!.cityProfiles.map((c) => c.city);
  assert.deepEqual([...cities].sort(), ['hangzhou', 'shanghai', 'suzhou', 'wuxi']);

  console.log('JOB_MATCH_PROFILE_SMOKE_PASS');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
