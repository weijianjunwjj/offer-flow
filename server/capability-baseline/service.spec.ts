import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type SqliteDatabase } from '../db';
import { initSchema } from '../schema';
import { ProfileRepository } from '../repositories/profileRepository';
import type { JobSeekerProfile } from '../../src/storage';
import {
  makeCandidateEvidenceContentFixture,
  makeCapabilityBaselineDraftFixture,
} from '../../src/domain/capability-baseline/testFixtures';
import type {
  CandidateEvidenceContent,
  CapabilityBaselineView,
} from '../../src/domain/capability-baseline';
import type { CapabilityBaselineAiProvider } from './aiProvider';
import { CapabilityBaselineService } from './service';

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

let tempDir: string;
let db: SqliteDatabase;
let clock: number;
let seq: number;

function fakeProvider(overrides: Partial<CapabilityBaselineAiProvider> = {}): CapabilityBaselineAiProvider {
  return {
    isConfigured: () => true,
    modelName: () => 'fake-model',
    generateEvidence: async () => ({
      rawText: JSON.stringify([makeCandidateEvidenceContentFixture({ sourceId: 'ai-src', summary: 'AI 生成的候选证据说明。' })]),
      model: 'fake-model',
    }),
    generateBaseline: async () => ({
      rawText: JSON.stringify(makeCapabilityBaselineDraftFixture()),
      model: 'fake-model',
    }),
    ...overrides,
  };
}

function buildService(provider?: CapabilityBaselineAiProvider): CapabilityBaselineService {
  return new CapabilityBaselineService(db, {
    now: () => (clock += 10),
    createId: () => `id-${(seq += 1)}`,
    aiProvider: provider ?? fakeProvider(),
  });
}

function key(): string {
  return `key-${(seq += 1)}`;
}

function addManualEvidence(
  service: CapabilityBaselineService,
  view: CapabilityBaselineView,
  overrides: Partial<CandidateEvidenceContent> = {},
): CapabilityBaselineView {
  return service.createManualEvidence({
    idempotencyKey: key(),
    expectedStateVersion: view.state.stateVersion,
    content: makeCandidateEvidenceContentFixture(overrides),
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-cb-service-'));
  db = openDb(path.join(tempDir, 'test.sqlite3'));
  initSchema(db, { targetVersion: 3 });
  new ProfileRepository(db).save(baseProfile());
  clock = 1_000;
  seq = 0;
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('CapabilityBaselineService · 候选证据', () => {
  it('空状态：无证据、无版本、无提案', () => {
    const view = buildService().getView();
    expect(view.state.stateVersion).toBe(0);
    expect(view.state.evidence).toHaveLength(0);
    expect(view.activeVersion).toBeNull();
  });

  it('手工创建候选证据：状态 proposed，未进入正式证据库', () => {
    const service = buildService();
    const view = addManualEvidence(service, service.getView());
    expect(view.state.evidence).toHaveLength(1);
    expect(view.state.evidence[0]!.status).toBe('proposed');
    expect(view.state.evidence[0]!.generatedBy).toBe('manual');
  });

  it('AI 创建候选证据：generatedBy=ai，仍为 proposed，需人工确认', async () => {
    const service = buildService();
    const view = await service.generateEvidence({ idempotencyKey: key(), expectedStateVersion: 0 });
    expect(view.state.evidence).toHaveLength(1);
    expect(view.state.evidence[0]!.generatedBy).toBe('ai');
    expect(view.state.evidence[0]!.status).toBe('proposed');
  });

  it('未确认候选证据不进入正式证据库；接受后才进入', () => {
    const service = buildService();
    let view = addManualEvidence(service, service.getView());
    const id = view.state.evidence[0]!.id;
    view = service.acceptEvidence(id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    const accepted = view.state.evidence.filter((e) => e.status === 'accepted' || e.status === 'modified_and_accepted');
    expect(accepted).toHaveLength(1);
  });

  it('修改后接受：保存修改后的内容与差异', () => {
    const service = buildService();
    let view = addManualEvidence(service, service.getView());
    const id = view.state.evidence[0]!.id;
    view = service.acceptEvidence(id, {
      idempotencyKey: key(),
      expectedStateVersion: view.state.stateVersion,
      modifiedContent: makeCandidateEvidenceContentFixture({ summary: '用户修改后的证据说明。' }),
    });
    const ev = view.state.evidence[0]!;
    expect(ev.status).toBe('modified_and_accepted');
    expect(ev.acceptedContent?.summary).toBe('用户修改后的证据说明。');
    expect(ev.summary).toBe(makeCandidateEvidenceContentFixture().summary);
    expect(ev.decisionDiff).toContain('summary');
  });

  it('拒绝后不进入证据库；来源与 sourceId 保留', () => {
    const service = buildService();
    let view = addManualEvidence(service, service.getView(), { sourceId: 'keep-me' });
    const id = view.state.evidence[0]!.id;
    view = service.rejectEvidence(id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.state.evidence[0]!.status).toBe('rejected');
    expect(view.state.evidence[0]!.sourceId).toBe('keep-me');
    expect(view.state.evidence.filter((e) => e.status === 'accepted')).toHaveLength(0);
  });

  it('稍后处理不改变正式证据库，可再次决策', () => {
    const service = buildService();
    let view = addManualEvidence(service, service.getView());
    const id = view.state.evidence[0]!.id;
    view = service.deferEvidence(id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.state.evidence[0]!.status).toBe('deferred');
    view = service.acceptEvidence(id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.state.evidence[0]!.status).toBe('accepted');
  });

  it('幂等重放：相同幂等键与请求返回同一状态，不重复创建', () => {
    const service = buildService();
    const idempotencyKey = key();
    const content = makeCandidateEvidenceContentFixture();
    const first = service.createManualEvidence({ idempotencyKey, expectedStateVersion: 0, content });
    // 幂等重放：客户端以完全相同的请求重试（相同 expectedStateVersion）。
    const replay = service.createManualEvidence({ idempotencyKey, expectedStateVersion: 0, content });
    expect(replay.state.evidence).toHaveLength(1);
    expect(replay.state.stateVersion).toBe(first.state.stateVersion);
  });

  it('幂等键复用于不同请求：抛 IDEMPOTENCY_KEY_REUSED', () => {
    const service = buildService();
    const idempotencyKey = key();
    service.createManualEvidence({ idempotencyKey, expectedStateVersion: 0, content: makeCandidateEvidenceContentFixture() });
    expect(() => service.createManualEvidence({
      idempotencyKey, expectedStateVersion: 1, content: makeCandidateEvidenceContentFixture({ summary: '不同内容以改变请求哈希。' }),
    })).toThrowError(/幂等键/);
  });

  it('乐观并发冲突：expectedStateVersion 过期抛 STATE_VERSION_CONFLICT', () => {
    const service = buildService();
    addManualEvidence(service, service.getView());
    expect(() => service.createManualEvidence({
      idempotencyKey: key(), expectedStateVersion: 0, content: makeCandidateEvidenceContentFixture({ summary: '基于过期版本的写入。' }),
    })).toThrowError(/状态已经变化/);
  });

  it('同源重复证据被拒绝去重', () => {
    const service = buildService();
    const view = addManualEvidence(service, service.getView());
    expect(() => service.createManualEvidence({
      idempotencyKey: key(),
      expectedStateVersion: view.state.stateVersion,
      content: makeCandidateEvidenceContentFixture(),
    })).toThrowError(/同源候选证据/);
  });

  it('支持证据与反证可以并存', () => {
    const service = buildService();
    let view = addManualEvidence(service, service.getView(), { polarity: 'support', summary: '支持证据说明。' });
    view = addManualEvidence(service, view, { polarity: 'counter', strength: 'medium', sourceType: 'user_input', sourceConfidence: 'exact', summary: '反证说明。' });
    const polarities = view.state.evidence.map((e) => e.polarity);
    expect(polarities).toContain('support');
    expect(polarities).toContain('counter');
  });
});

describe('CapabilityBaselineService · 业务护栏', () => {
  it('短期反馈事件不得作为强反证（feedback_event + counter + 非确证 + 强/中）', () => {
    const service = buildService();
    expect(() => service.createManualEvidence({
      idempotencyKey: key(),
      expectedStateVersion: 0,
      content: makeCandidateEvidenceContentFixture({
        polarity: 'counter', strength: 'strong', sourceType: 'feedback_event', sourceConfidence: 'recalled',
        summary: '单次无回复被误当作强反证。',
      }),
    })).toThrowError(/强反证/);
  });

  it('确证的能力反证允许录入（sourceConfidence=exact）', () => {
    const service = buildService();
    const view = service.createManualEvidence({
      idempotencyKey: key(),
      expectedStateVersion: 0,
      content: makeCandidateEvidenceContentFixture({
        polarity: 'counter', strength: 'medium', sourceType: 'feedback_event', sourceConfidence: 'exact',
        summary: '面试中明确因能力被拒的确证反证。',
      }),
    });
    expect(view.state.evidence[0]!.polarity).toBe('counter');
  });
});

describe('CapabilityBaselineService · 能力基线版本', () => {
  function acceptOneEvidence(service: CapabilityBaselineService): { view: CapabilityBaselineView; evidenceId: string } {
    let view = addManualEvidence(service, service.getView());
    const evidenceId = view.state.evidence[0]!.id;
    view = service.acceptEvidence(evidenceId, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    return { view, evidenceId };
  }

  it('手工基线提案：proposed，不改变 active baseline', () => {
    const service = buildService();
    const { view: seeded, evidenceId } = acceptOneEvidence(service);
    const view = service.createManualBaselineProposal({
      idempotencyKey: key(),
      expectedStateVersion: seeded.state.stateVersion,
      payload: makeCapabilityBaselineDraftFixture([evidenceId]),
    });
    expect(view.state.proposals).toHaveLength(1);
    expect(view.state.proposals[0]!.status).toBe('proposed');
    expect(view.activeVersion).toBeNull();
  });

  it('AI 基线提案：generatedBy=ai，不自动激活', async () => {
    const service = buildService();
    const view = await service.generateBaselineProposal({ idempotencyKey: key(), expectedStateVersion: 0 });
    expect(view.state.proposals[0]!.generatedBy).toBe('ai');
    expect(view.activeVersion).toBeNull();
  });

  it('接受基线提案创建 V1；再修改后接受创建 V2 且 V1 归档不可原地修改', () => {
    const service = buildService();
    const { view: seeded, evidenceId } = acceptOneEvidence(service);
    let view = service.createManualBaselineProposal({
      idempotencyKey: key(), expectedStateVersion: seeded.state.stateVersion,
      payload: makeCapabilityBaselineDraftFixture([evidenceId]),
    });
    const firstProposalId = view.state.proposals[0]!.id;
    view = service.acceptBaselineProposal(firstProposalId, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.activeVersion?.version).toBe(1);
    const v1Before = view.state.versions.find((v) => v.version === 1)!;
    const v1ContentBefore = JSON.stringify({
      summary: v1Before.summary,
      capabilities: v1Before.capabilities,
      externalConstraints: v1Before.externalConstraints,
      overallConfidence: v1Before.overallConfidence,
      largestUncertainties: v1Before.largestUncertainties,
      createdAt: v1Before.createdAt,
      activatedAt: v1Before.activatedAt,
    });

    view = service.createManualBaselineProposal({
      idempotencyKey: key(), expectedStateVersion: view.state.stateVersion,
      payload: makeCapabilityBaselineDraftFixture([evidenceId]),
    });
    const secondProposalId = view.state.proposals.find((p) => p.status === 'proposed')!.id;
    view = service.acceptBaselineProposal(secondProposalId, {
      idempotencyKey: key(), expectedStateVersion: view.state.stateVersion,
      modifiedPayload: { ...makeCapabilityBaselineDraftFixture([evidenceId]), summary: '修改后的基线概述。' },
    });
    expect(view.activeVersion?.version).toBe(2);
    const v1After = view.state.versions.find((v) => v.version === 1)!;
    expect(v1After.status).toBe('archived');
    // 已激活版本内容不可原地修改：归档后除状态外内容与时间戳均不变。
    expect(JSON.stringify({
      summary: v1After.summary,
      capabilities: v1After.capabilities,
      externalConstraints: v1After.externalConstraints,
      overallConfidence: v1After.overallConfidence,
      largestUncertainties: v1After.largestUncertainties,
      createdAt: v1After.createdAt,
      activatedAt: v1After.activatedAt,
    })).toBe(v1ContentBefore);
  });

  it('历史版本可重新激活', () => {
    const service = buildService();
    const { view: seeded, evidenceId } = acceptOneEvidence(service);
    let view = service.createManualBaselineProposal({
      idempotencyKey: key(), expectedStateVersion: seeded.state.stateVersion, payload: makeCapabilityBaselineDraftFixture([evidenceId]),
    });
    view = service.acceptBaselineProposal(view.state.proposals[0]!.id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    const v1Id = view.activeVersion!.id;
    view = service.createManualBaselineProposal({
      idempotencyKey: key(), expectedStateVersion: view.state.stateVersion, payload: { ...makeCapabilityBaselineDraftFixture([evidenceId]), summary: '第二版基线。' },
    });
    view = service.acceptBaselineProposal(view.state.proposals.find((p) => p.status === 'proposed')!.id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.activeVersion!.version).toBe(2);
    view = service.activateVersion(v1Id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion, confirmed: true });
    expect(view.activeVersion!.id).toBe(v1Id);
  });

  it('拒绝 / 稍后处理基线提案不改变 active', () => {
    const service = buildService();
    const { view: seeded, evidenceId } = acceptOneEvidence(service);
    let view = service.createManualBaselineProposal({
      idempotencyKey: key(), expectedStateVersion: seeded.state.stateVersion, payload: makeCapabilityBaselineDraftFixture([evidenceId]),
    });
    view = service.rejectBaselineProposal(view.state.proposals[0]!.id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.activeVersion).toBeNull();
    expect(view.state.proposals[0]!.status).toBe('rejected');
  });

  it('正式版本引用的证据必须存在且已接受', () => {
    const service = buildService();
    const { view: seeded } = acceptOneEvidence(service);
    expect(() => service.createManualBaselineProposal({
      idempotencyKey: key(),
      expectedStateVersion: seeded.state.stateVersion,
      payload: makeCapabilityBaselineDraftFixture(['nonexistent-evidence-id']),
    })).toThrowError(/引用的证据/);
  });

  it('AI 提案编造的非 id 证据引用被清洗，提案可被接受（不报 EVIDENCE_REFERENCE_MISSING）', async () => {
    const hallucinated = makeCapabilityBaselineDraftFixture();
    hallucinated.capabilities[0]!.supportingEvidenceRefs = ['简历/工作经历', 'profile.weaknessNote'];
    hallucinated.externalConstraints[0]!.evidenceRefs = ['profile.targetCity'];
    const provider = fakeProvider({
      generateBaseline: async () => ({ rawText: JSON.stringify(hallucinated), model: 'fake-model' }),
    });
    const service = buildService(provider);
    let view = await service.generateBaselineProposal({ idempotencyKey: key(), expectedStateVersion: 0 });
    const proposal = view.state.proposals[0]!;
    expect(proposal.payload.capabilities[0]!.supportingEvidenceRefs).toEqual([]);
    expect(proposal.payload.externalConstraints[0]!.evidenceRefs).toEqual([]);
    view = service.acceptBaselineProposal(proposal.id, { idempotencyKey: key(), expectedStateVersion: view.state.stateVersion });
    expect(view.activeVersion?.version).toBe(1);
  });

  it('生成期间输入指纹变化：阻止过期 AI 结果写入', async () => {
    const mutatingProvider = fakeProvider({
      generateBaseline: async () => {
        // 生成期间用户改动了简历资料，导致输入指纹变化。
        new ProfileRepository(db).save({ ...baseProfile(), resumeText: '在生成期间被改动的简历文本' });
        return { rawText: JSON.stringify(makeCapabilityBaselineDraftFixture()), model: 'fake-model' };
      },
    });
    const service = buildService(mutatingProvider);
    await expect(service.generateBaselineProposal({ idempotencyKey: key(), expectedStateVersion: 0 }))
      .rejects.toMatchObject({ code: 'STATE_VERSION_CONFLICT' });
  });
});
