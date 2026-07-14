import { describe, expect, it } from 'vitest';
import {
  activateJobMatchProfileVersion,
  addJobMatchProfileProposal,
  createEmptyJobMatchProfileState,
  createManualJobMatchProfileDraft,
  decideJobMatchProfileProposal,
  getActiveJobMatchProfileVersion,
} from './index';

const seed = {
  resumeText: '7 年前端经验，Vue 与 TypeScript。',
  projectExperience: '负责数据分析平台、工程化提速和 AI 应用闭环。',
  targetCity: '苏州',
  targetRole: '产品型前端 / AI 应用工程师',
  expectedSalary: '16-20K',
  weaknessNote: '学历门槛需要单独验证',
};

describe('JobMatchProfileState', () => {
  it('未确认提案不影响正式画像', () => {
    const draft = createManualJobMatchProfileDraft(seed);
    const { state, proposal } = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
      id: 'proposal-1',
      source: 'manual',
      draft,
      createdAt: 100,
    });

    expect(proposal.status).toBe('proposed');
    expect(state.activeVersionId).toBeNull();
    expect(state.versions).toHaveLength(0);
    expect(state.stateVersion).toBe(1);
  });

  it('接受提案生成不可原地覆盖的新版本', () => {
    const draft = createManualJobMatchProfileDraft(seed);
    const proposed = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
      id: 'proposal-1',
      source: 'manual',
      draft,
      createdAt: 100,
    }).state;

    const accepted = decideJobMatchProfileProposal(proposed, {
      proposalId: 'proposal-1',
      action: 'accept',
      versionId: 'version-1',
      now: 200,
      note: '确认第一版',
    });

    expect(accepted.activeVersionId).toBe('version-1');
    expect(accepted.versions[0]?.versionNumber).toBe(1);
    expect(accepted.versions[0]?.draft.global.corePositioning).toBe(draft.global.corePositioning);
    expect(accepted.proposals[0]?.status).toBe('accepted');

    const changedDraft = structuredClone(draft);
    changedDraft.global.corePositioning = '修改后的定位';
    expect(accepted.versions[0]?.draft.global.corePositioning).not.toBe(changedDraft.global.corePositioning);
  });

  it('修改后接受保留原提案并激活修改后的版本', () => {
    const original = createManualJobMatchProfileDraft(seed);
    const modified = structuredClone(original);
    modified.global.corePositioning = 'AI 应用全栈 / 产品工程师';
    const proposed = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
      id: 'proposal-1',
      source: 'ai',
      draft: original,
      createdAt: 100,
      aiRun: { model: 'test-model', promptVersion: 'v1', rawText: '{}', createdAt: 100 },
    }).state;

    const accepted = decideJobMatchProfileProposal(proposed, {
      proposalId: 'proposal-1',
      action: 'modify_and_accept',
      versionId: 'version-1',
      modifiedDraft: modified,
      now: 200,
    });

    expect(accepted.proposals[0]?.draft.global.corePositioning).toBe(original.global.corePositioning);
    expect(accepted.versions[0]?.draft.global.corePositioning).toBe('AI 应用全栈 / 产品工程师');
    expect(accepted.proposals[0]?.status).toBe('modified_and_accepted');
  });

  it('拒绝和稍后处理都不会创建正式版本', () => {
    const draft = createManualJobMatchProfileDraft(seed);
    const proposed = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
      id: 'proposal-1',
      source: 'manual',
      draft,
      createdAt: 100,
    }).state;
    const deferred = decideJobMatchProfileProposal(proposed, {
      proposalId: 'proposal-1',
      action: 'defer',
      now: 200,
      deferredUntil: 300,
    });
    const rejected = decideJobMatchProfileProposal(deferred, {
      proposalId: 'proposal-1',
      action: 'reject',
      now: 400,
    });

    expect(rejected.versions).toHaveLength(0);
    expect(rejected.activeVersionId).toBeNull();
    expect(rejected.proposals[0]?.status).toBe('rejected');
  });

  it('四城市视图独立，城市市场字段不会被同一个对象引用串改', () => {
    const draft = createManualJobMatchProfileDraft(seed);
    draft.suzhou.focus.salaryRange = '苏州独立证据待确认';

    expect(draft.wuxi.focus.salaryRange).not.toBe('苏州独立证据待确认');
    expect(draft.shanghai.scope).toBe('shanghai');
    expect(draft.hangzhou.scope).toBe('hangzhou');
  });

  it('可以切回历史版本且不删除任何版本', () => {
    const firstDraft = createManualJobMatchProfileDraft(seed);
    const firstProposal = addJobMatchProfileProposal(createEmptyJobMatchProfileState(), {
      id: 'proposal-1', source: 'manual', draft: firstDraft, createdAt: 100,
    }).state;
    const firstAccepted = decideJobMatchProfileProposal(firstProposal, {
      proposalId: 'proposal-1', action: 'accept', versionId: 'version-1', now: 200,
    });
    const secondDraft = structuredClone(firstDraft);
    secondDraft.global.corePositioning = '第二版定位';
    const secondProposal = addJobMatchProfileProposal(firstAccepted, {
      id: 'proposal-2', source: 'manual', draft: secondDraft, createdAt: 300,
    }).state;
    const secondAccepted = decideJobMatchProfileProposal(secondProposal, {
      proposalId: 'proposal-2', action: 'accept', versionId: 'version-2', now: 400,
    });
    const switched = activateJobMatchProfileVersion(secondAccepted, 'version-1', 500);

    expect(switched.versions).toHaveLength(2);
    expect(getActiveJobMatchProfileVersion(switched)?.id).toBe('version-1');
    expect(switched.versions.find((item) => item.id === 'version-2')).toBeDefined();
  });
});
