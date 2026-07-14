import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { ProfileRepository } from '../repositories/profileRepository';
import type { JobSeekerProfile } from '../../src/storage';
import {
  makeJobMatchProfileDraftFixture,
} from '../../src/domain/job-match-profile/testFixtures';
import type { JobMatchProfileDraft } from '../../src/domain/job-match-profile';
import type { JobMatchProfileAiProvider } from './aiProvider';
import { JobMatchProfileError } from './errors';
import { JobMatchProfileService } from './service';

function baseProfile(): JobSeekerProfile {
  return {
    resumeText: 'Vue / TypeScript / Node.js',
    projectExperience: '复杂 B 端与 AI 应用工程',
    targetCity: '苏州',
    targetRole: 'AI 应用前端工程师',
    expectedSalary: '25-35K',
    acceptOutsourcing: false,
    acceptOvertime: true,
    jobSearchFocus: 'growth',
    weaknessNote: '大型 AI 生产证明不足',
  };
}

function makeDraft(northStar: string): JobMatchProfileDraft {
  return { ...makeJobMatchProfileDraftFixture(), northStarPositioning: northStar };
}

let tempDir: string;
let db: SqliteDatabase;
let clock: number;
let seq: number;

function buildService(provider?: JobMatchProfileAiProvider): JobMatchProfileService {
  return new JobMatchProfileService(db, {
    now: () => (clock += 10),
    createId: () => `id-${(seq += 1)}`,
    aiProvider: provider ?? {
      isConfigured: () => true,
      modelName: () => 'fake-model',
      generate: async () => ({
        rawText: JSON.stringify(makeDraft('AI 建议定位')),
        model: 'fake-model',
      }),
    },
  });
}

function latestProposalId(proposals: Array<{ id: string }>): string {
  return proposals[proposals.length - 1]!.id;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-jmp-service-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 2 });
  new ProfileRepository(db).save(baseProfile());
  clock = 1_000;
  seq = 0;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('JobMatchProfileService · 核心链路', () => {
  it('空状态：无版本、无提案、置信不足', () => {
    const view = buildService().getProfile();
    expect(view.state.stateVersion).toBe(0);
    expect(view.activeVersion).toBeNull();
    expect(view.state.proposals).toHaveLength(0);
  });

  it('手工 proposal 未确认时不影响 active version', () => {
    const service = buildService();
    const view = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('手工草案'),
    });
    expect(view.state.proposals).toHaveLength(1);
    expect(view.state.proposals[0]?.status).toBe('proposed');
    expect(view.state.proposals[0]?.generatedBy).toBe('manual');
    expect(view.activeVersion).toBeNull();
  });

  it('AI proposal 使用严格 Draft Schema，非法输出被拒绝', async () => {
    const service = buildService();
    const view = await service.generateProposal({ idempotencyKey: 'ai', expectedProfileStateVersion: 0 });
    const aiProposal = view.state.proposals.find((p) => p.generatedBy === 'ai');
    expect(aiProposal?.status).toBe('proposed');
    expect(aiProposal?.modelInfo).toBe('fake-model');
    expect(view.activeVersion).toBeNull();

    const badService = buildService({
      isConfigured: () => true,
      modelName: () => 'bad-model',
      generate: async () => ({ rawText: '{"not":"a valid draft"}', model: 'bad-model' }),
    });
    await expect(badService.generateProposal({ idempotencyKey: 'ai-bad', expectedProfileStateVersion: 1 }))
      .rejects.toMatchObject({ code: 'AI_STRUCTURED_OUTPUT_INVALID' });
  });

  it('AI 未配置时拒绝生成（AI 只在显式配置下运行）', async () => {
    const service = buildService({
      isConfigured: () => false,
      modelName: () => 'unconfigured',
      generate: async () => { throw new Error('不应被调用'); },
    });
    await expect(service.generateProposal({ idempotencyKey: 'ai', expectedProfileStateVersion: 0 }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' });
  });

  it('接受 proposal 创建新版本并归档旧版本', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('版本一'),
    });
    const v1 = service.acceptProposal(latestProposalId(p1.state.proposals), {
      idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion,
    });
    expect(v1.activeVersion?.version).toBe(1);
    expect(v1.state.versions).toHaveLength(1);
    expect(v1.state.proposals[0]?.status).toBe('accepted');

    const p2 = service.createManualProposal({
      idempotencyKey: 'k2', expectedProfileStateVersion: v1.state.stateVersion, payload: makeDraft('版本二'),
    });
    const v2 = service.acceptProposal(latestProposalId(p2.state.proposals), {
      idempotencyKey: 'a2', expectedProfileStateVersion: p2.state.stateVersion,
    });
    expect(v2.activeVersion?.version).toBe(2);
    expect(v2.state.versions).toHaveLength(2);
    const archived = v2.state.versions.find((v) => v.version === 1);
    expect(archived?.status).toBe('archived');
  });

  it('修改后接受保存修改后的正式内容', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('原始草案'),
    });
    const modified = makeDraft('修改后的正式定位');
    const view = service.acceptProposal(latestProposalId(p1.state.proposals), {
      idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion, modifiedPayload: modified,
    });
    expect(view.activeVersion?.northStarPositioning).toBe('修改后的正式定位');
    const proposal = view.state.proposals[0];
    expect(proposal?.status).toBe('modified_and_accepted');
    expect(proposal?.acceptedPayload?.northStarPositioning).toBe('修改后的正式定位');
    expect(proposal?.payload.northStarPositioning).toBe('原始草案');
  });

  it('拒绝与稍后处理不影响正式画像', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('先建立正式版本'),
    });
    const v1 = service.acceptProposal(latestProposalId(p1.state.proposals), {
      idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion,
    });
    const activeId = v1.activeVersion?.id;

    const pr = service.createManualProposal({
      idempotencyKey: 'k2', expectedProfileStateVersion: v1.state.stateVersion, payload: makeDraft('待拒绝'),
    });
    const rejected = service.rejectProposal(latestProposalId(pr.state.proposals), {
      idempotencyKey: 'r1', expectedProfileStateVersion: pr.state.stateVersion,
    });
    expect(rejected.activeVersion?.id).toBe(activeId);
    expect(rejected.state.proposals.some((p) => p.status === 'rejected')).toBe(true);

    const pd = service.createManualProposal({
      idempotencyKey: 'k3', expectedProfileStateVersion: rejected.state.stateVersion, payload: makeDraft('待稍后'),
    });
    const deferred = service.deferProposal(latestProposalId(pd.state.proposals), {
      idempotencyKey: 'd1', expectedProfileStateVersion: pd.state.stateVersion,
    });
    expect(deferred.activeVersion?.id).toBe(activeId);
    expect(deferred.state.proposals.some((p) => p.status === 'deferred')).toBe(true);
  });

  it('乐观并发冲突：过期 stateVersion 被拒绝', () => {
    const service = buildService();
    service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('第一次'),
    });
    expect(() => service.createManualProposal({
      idempotencyKey: 'k2', expectedProfileStateVersion: 0, payload: makeDraft('过期写入'),
    })).toThrow(JobMatchProfileError);
    try {
      service.createManualProposal({ idempotencyKey: 'k3', expectedProfileStateVersion: 0, payload: makeDraft('再试') });
    } catch (error) {
      expect((error as JobMatchProfileError).code).toBe('PROFILE_VERSION_CONFLICT');
    }
  });

  it('请求幂等：相同幂等键 + 相同请求不产生新提案', () => {
    const service = buildService();
    const input = { idempotencyKey: 'dup', expectedProfileStateVersion: 0, payload: makeDraft('幂等') };
    const first = service.createManualProposal(input);
    const second = service.createManualProposal(input);
    expect(second.state.proposals).toHaveLength(first.state.proposals.length);
    expect(second.state.stateVersion).toBe(first.state.stateVersion);
  });

  it('已激活版本不可原地修改：切换到历史版本内容保持不变', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('版本一内容'),
    });
    const v1 = service.acceptProposal(latestProposalId(p1.state.proposals), {
      idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion,
    });
    const v1Id = v1.activeVersion!.id;

    const p2 = service.createManualProposal({
      idempotencyKey: 'k2', expectedProfileStateVersion: v1.state.stateVersion, payload: makeDraft('版本二内容'),
    });
    const v2 = service.acceptProposal(latestProposalId(p2.state.proposals), {
      idempotencyKey: 'a2', expectedProfileStateVersion: p2.state.stateVersion,
    });

    const switched = service.activateVersion(v1Id, {
      idempotencyKey: 'sw1', expectedProfileStateVersion: v2.state.stateVersion, confirmed: true,
    });
    expect(switched.state.activeVersionId).toBe(v1Id);
    expect(switched.activeVersion?.northStarPositioning).toBe('版本一内容');
    // V1 原始内容未被 V2 覆盖
    expect(switched.state.versions.find((v) => v.id === v1Id)?.northStarPositioning).toBe('版本一内容');
  });

  it('四城市相互独立：借用证据带来源、原因、降权与不适用范围', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeJobMatchProfileDraftFixture(),
    });
    const v1 = service.acceptProposal(latestProposalId(p1.state.proposals), {
      idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion,
    });
    const cities = v1.activeVersion!.cityProfiles.map((c) => c.city).sort();
    expect(cities).toEqual(['hangzhou', 'shanghai', 'suzhou', 'wuxi']);
    const wuxi = v1.activeVersion!.cityProfiles.find((c) => c.city === 'wuxi');
    expect(wuxi?.borrowedEvidence[0]?.sourceCity).toBe('suzhou');
    expect(wuxi?.borrowedEvidence[0]?.notApplicableTo).toContain('薪资');
    // 苏州本地样本不借用给其它城市的薪资结论
    const shanghai = v1.activeVersion!.cityProfiles.find((c) => c.city === 'shanghai');
    expect(shanghai?.borrowedEvidence).toHaveLength(0);
  });

  it('样本不足画像默认阻断正式结论（置信为不足/探索性）', () => {
    const draft = makeJobMatchProfileDraftFixture();
    expect(['insufficient', 'exploratory']).toContain(draft.confidence);
    expect(draft.cityProfiles.every((c) => ['insufficient', 'exploratory'].includes(c.confidence))).toBe(true);
  });

  it('已决议的 proposal 不能再次决议', () => {
    const service = buildService();
    const p1 = service.createManualProposal({
      idempotencyKey: 'k1', expectedProfileStateVersion: 0, payload: makeDraft('唯一草案'),
    });
    const id = latestProposalId(p1.state.proposals);
    const accepted = service.acceptProposal(id, { idempotencyKey: 'a1', expectedProfileStateVersion: p1.state.stateVersion });
    expect(() => service.rejectProposal(id, {
      idempotencyKey: 'r1', expectedProfileStateVersion: accepted.state.stateVersion,
    })).toThrow(JobMatchProfileError);
  });
});
