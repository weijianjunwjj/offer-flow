import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  CandidateDecisionDetail, DecisionFeedItem, RelationListItem, RuleEvidenceView,
} from '../api/radarReviewApi';
import RadarReviewPage from './RadarReviewPage.vue';

const mocks = vi.hoisted(() => ({
  listRelations: vi.fn(),
  listDecisionFeed: vi.fn(),
  getCandidateDetail: vi.fn(),
  listRuleEvidence: vi.fn(),
  confirmSame: vi.fn(),
  confirmDistinct: vi.fn(),
  revert: vi.fn(),
  requestRecheck: vi.fn(),
  setOverride: vi.fn(),
  revertOverride: vi.fn(),
}));
vi.mock('../api/radarReviewApi', () => ({ radarReviewApi: mocks }));

function summary(company: string) {
  return {
    candidateId: `cand-${company}`, activeCandidateVersionId: `ver-${company}`,
    company, role: '前端工程师', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月',
    experienceRequirement: '3-5年', educationRequirement: '本科', jdExcerpt: 'JD 摘要',
    normalizedSourceUrl: 'https://www.zhipin.com/job_detail/x.html', sourceDomain: null,
  };
}

function relation(over: Partial<RelationListItem> = {}): RelationListItem {
  return {
    relationId: 'rel-1', candidateIdLow: 'cand-A', candidateIdHigh: 'cand-B',
    status: 'suspected_duplicate', reasonCode: 'same_company_role',
    signals: { companyNameSimilar: true, reason: '公司名相似' },
    firstDetectedAt: 1000, lastDetectedAt: 2000,
    lowSummary: summary('A公司'), highSummary: summary('B公司'), hasPriorDecision: false, ...over,
  };
}

function detail(over: Partial<CandidateDecisionDetail> = {}): CandidateDecisionDetail {
  return {
    candidateId: 'cand-A', activeCandidateVersionId: 'ver-A', decisionType: 'material_change',
    analysisEligible: true, blockingIssues: [], needsConfirmation: [], conflictReason: null,
    changedFields: [{ fieldPath: 'salaryMinK', before: 15, after: 20, classification: 'changed_fact', reason: 'salaryMinK value_changed' }],
    latestSnapshotId: 'snap-1', currentVersion: summary('A公司'), previousVersion: summary('A公司'),
    sourceLinks: [], ...over,
  };
}

function setupHappy(relOver: Partial<RelationListItem> = {}, feed: DecisionFeedItem[] = []): void {
  mocks.listRelations.mockResolvedValue([relation(relOver)]);
  mocks.listDecisionFeed.mockResolvedValue(feed);
  mocks.getCandidateDetail.mockResolvedValue(detail());
  mocks.listRuleEvidence.mockResolvedValue([]);
}

afterEach(() => { vi.clearAllMocks(); });

async function mountPage() {
  // NModal 默认 teleport 到 body，stub teleport 让弹窗内容内联渲染，便于断言。
  const wrapper = mount(RadarReviewPage, { global: { stubs: { teleport: true } } });
  await flushPromises();
  return wrapper;
}

describe('RadarReviewPage 待处理关系 + 决策 feed', () => {
  it('渲染待处理关系列表并携带脱敏 signals', async () => {
    setupHappy();
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="relation-list"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('A公司');
  });

  it('决策 feed 展示 identity_conflict 的结构化冲突原因', async () => {
    setupHappy({}, [{
      snapshotId: 'snap-c', candidateId: null, activeCandidateVersionId: null,
      decisionType: 'identity_conflict', analysisEligible: false,
      blockingIssues: ['identity_conflict: tier2_multiple_matches'], needsConfirmation: [],
      conflictReason: 'tier2_multiple_matches', changedFieldPaths: [], summary: null,
    }]);
    const wrapper = await mountPage();
    const el = wrapper.find('[data-testid="feed-conflict-reason"]');
    expect(el.exists()).toBe(true);
    expect(el.text()).toContain('tier2_multiple_matches');
  });
});

describe('RadarReviewPage 候选对比 + 变化 + 证据', () => {
  it('选中关系后展示两侧候选对比与变化字段', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(true);
    const changed = wrapper.find('[data-testid="changed-field"]');
    expect(changed.exists()).toBe(true);
    expect(changed.text()).toContain('salaryMinK');
  });

  it('点击决策 feed 中带候选的条目加载单侧详情与证据（无关系裁决按钮）', async () => {
    setupHappy({}, [{
      snapshotId: 'snap-m', candidateId: 'cand-A', activeCandidateVersionId: 'ver-A',
      decisionType: 'material_change', analysisEligible: true, blockingIssues: [],
      needsConfirmation: [], conflictReason: null, changedFieldPaths: ['salaryMinK'], summary: summary('越迁软件'),
    }]);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="feed-open-snap-m"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(true);
    expect(mocks.getCandidateDetail).toHaveBeenCalledWith('cand-A');
    // 单候选查看不应出现关系裁决按钮。
    expect(wrapper.find('[data-testid="btn-confirm-same"]').exists()).toBe(false);
  });

  it('决策 feed 中无候选（identity_conflict）条目不可点击', async () => {
    setupHappy({}, [{
      snapshotId: 'snap-c', candidateId: null, activeCandidateVersionId: null,
      decisionType: 'identity_conflict', analysisEligible: false, blockingIssues: ['x'],
      needsConfirmation: [], conflictReason: 'tier2_multiple_matches', changedFieldPaths: [], summary: null,
    }]);
    const wrapper = await mountPage();
    const btn = wrapper.find('[data-testid="feed-open-snap-c"]');
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('规则证据区分 structured / legacy_scalar / corrupt 三态', async () => {
    setupHappy();
    const evidence: RuleEvidenceView[] = [
      { assessmentId: 'a1', ruleKey: 'salary_floor', evidenceState: 'structured', corruptReason: null, overrideState: 'none', ruleId: 'salary_floor', ruleVersion: 'v1', outcome: 'matched', matchedFieldPath: 'salaryMinK', rawValue: '20', normalizedValue: 20, excerpt: '摘要', explanation: '说明', confidence: 0.9, blocking: true, matchedText: '20K' },
      { assessmentId: 'a2', ruleKey: 'city', evidenceState: 'legacy_scalar', corruptReason: null, overrideState: 'none', ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null, rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null, matchedText: '苏州' },
      { assessmentId: 'a3', ruleKey: 'commute', evidenceState: 'corrupt', corruptReason: 'schema mismatch', overrideState: 'none', ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null, rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null, matchedText: null },
    ];
    mocks.listRuleEvidence.mockResolvedValue(evidence);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="evidence-structured"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="evidence-legacy_scalar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="evidence-corrupt"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('schema mismatch');
  });
});

describe('RadarReviewPage 人工操作二次确认 + 语义 + 409', () => {
  it('确认相同的文案明确不物理合并/不删除/不迁移', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    const note = wrapper.find('[data-testid="merge-note"]');
    expect(note.exists()).toBe(true);
    expect(note.text()).toMatch(/不会立即删除、合并或迁移/);
  });

  it('写操作必须二次确认且原因必填后才发请求', async () => {
    setupHappy();
    mocks.confirmDistinct.mockResolvedValue({ status: 'confirmed_distinct' });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="btn-confirm-distinct"]').trigger('click');
    await flushPromises();
    // 未填原因：不发请求。
    expect(mocks.confirmDistinct).not.toHaveBeenCalled();
    const vm = wrapper.vm as unknown as { reasonDraft: string };
    vm.reasonDraft = '两家为不同法人';
    await flushPromises();
    await wrapper.find('[data-testid="confirm-submit"]').trigger('click');
    await flushPromises();
    expect(mocks.confirmDistinct).toHaveBeenCalledOnce();
    expect(mocks.confirmDistinct.mock.calls[0]![0]).toMatchObject({
      relationId: 'rel-1', reason: '两家为不同法人', expectedCurrentStatus: 'suspected_duplicate',
    });
  });

  it('并发冲突（409）提示刷新且不清空已填原因', async () => {
    setupHappy();
    mocks.confirmSame.mockRejectedValue(new ApiError('conflict', 409, { code: 'RELATION_STATE_CONFLICT' }));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="btn-confirm-same"]').trigger('click');
    const vm = wrapper.vm as unknown as { reasonDraft: string };
    vm.reasonDraft = '同一岗位';
    await flushPromises();
    await wrapper.find('[data-testid="confirm-submit"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="stale-hint"]').exists()).toBe(true);
    expect(vm.reasonDraft).toBe('同一岗位'); // 输入保留
  });
});
