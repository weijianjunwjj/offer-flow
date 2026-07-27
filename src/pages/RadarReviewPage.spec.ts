import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  CandidateDecisionDetail, DecisionFeedItem, RelationDetail, RelationListItem, RelationSignals, RuleEvidenceView,
} from '../api/radarReviewApi';
import RadarReviewPage from './RadarReviewPage.vue';

const mocks = vi.hoisted(() => ({
  listRelations: vi.fn(),
  getRelationDetail: vi.fn(),
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

// 可变 features mock：默认与生产一致（两个能力均关闭），单测内按需打开 V8-5 推荐门禁。
const featureFlags = vi.hoisted(() => ({ radarAnalysisEnabled: false, radarRecommendationsEnabled: false }));
vi.mock('../config/features', () => ({ features: featureFlags }));

// 推荐面板依赖的推荐 API：本文件只验证入口可发现性（位置/标题/引导），不触发真实请求。
vi.mock('../api/radarRecommendationApi', () => ({
  radarRecommendationApi: { createBatch: vi.fn(), listRecentBatches: vi.fn(), getBatch: vi.fn() },
}));

function summary(company: string) {
  return {
    candidateId: `cand-${company}`, activeCandidateVersionId: `ver-${company}`,
    company, role: '前端工程师', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月',
    experienceRequirement: '3-5年', educationRequirement: '本科', jdExcerpt: 'JD 摘要',
    normalizedSourceUrl: 'https://www.zhipin.com/job_detail/x.html', sourceDomain: null,
  };
}

function presentSignals(): RelationSignals {
  return {
    state: 'present',
    signals: [
      { signalType: 'company_name_similar', field: 'company', candidateAValue: '同城科技', candidateBValue: '同城科技(分部)', strength: 0.86, explanation: '公司名高度相似' },
      { signalType: 'role_title_equal', field: 'role', candidateAValue: '前端工程师', candidateBValue: '前端工程师', strength: 1, explanation: '岗位标题一致' },
    ],
    corruptReason: null,
  };
}

function relation(over: Partial<RelationListItem> = {}): RelationListItem {
  return {
    relationId: 'rel-1', candidateIdLow: 'cand-A', candidateIdHigh: 'cand-B',
    status: 'suspected_duplicate', reasonCode: 'same_company_role',
    signals: presentSignals(),
    firstDetectedAt: 1000, lastDetectedAt: 2000,
    lowSummary: summary('A公司'), highSummary: summary('B公司'), hasPriorDecision: false, ...over,
  };
}

function relationDetail(over: Partial<RelationDetail> = {}): RelationDetail {
  return {
    relationId: 'rel-1', candidateIdLow: 'cand-A', candidateIdHigh: 'cand-B',
    status: 'suspected_duplicate', reasonCode: 'same_company_role', decisionReason: null,
    signals: presentSignals(), firstDetectedAt: 1000, lastDetectedAt: 2000, decidedAt: null,
    lowSummary: summary('A公司'), highSummary: summary('B公司'), auditTimeline: [], ...over,
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

function setupHappy(relOver: Partial<RelationListItem> = {}, feed: DecisionFeedItem[] = [], detailOver: Partial<RelationDetail> = {}): void {
  mocks.listRelations.mockResolvedValue([relation(relOver)]);
  mocks.getRelationDetail.mockResolvedValue(relationDetail({ status: relOver.status, ...detailOver }));
  mocks.listDecisionFeed.mockResolvedValue(feed);
  mocks.getCandidateDetail.mockResolvedValue(detail());
  mocks.listRuleEvidence.mockResolvedValue([]);
}

afterEach(() => {
  vi.clearAllMocks();
  // 复位 flag，避免用例间互相污染（默认与生产一致：两个能力均关闭）。
  featureFlags.radarAnalysisEnabled = false;
  featureFlags.radarRecommendationsEnabled = false;
});

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

  it('V8-4 分析面板默认关闭：flag=false 时不渲染分析面板（V8-3 行为不变）', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    // radarAnalysisEnabled 默认 false：候选对比区不嵌入任何分析面板。
    expect(wrapper.find('[data-testid="analysis-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-panel-low"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-panel-high"]').exists()).toBe(false);
  });

  it('V8-5 推荐面板默认关闭：flag=false 时不渲染，且不影响 V8-4 分析面板行为', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    // radarRecommendationsEnabled 默认 false：不渲染推荐面板；同时 V8-4 分析面板行为不因本能力改变。
    expect(wrapper.find('[data-testid="recommendation-panel-review"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="recommendation-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-panel-low"]').exists()).toBe(false);
    // 候选对比区仍正常渲染（推荐能力关闭不破坏既有评审 UI）。
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(true);
  });

  it('V8-5 推荐入口可发现性：未选关系即渲染面板并提示「请先选择一组岗位」', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const wrapper = await mountPage();
    // 未选中任何关系：面板已可见（不再埋在长页面底部），且不显示生成/加载操作。
    const panel = wrapper.find('[data-testid="recommendation-panel-review"]');
    expect(panel.exists()).toBe(true);
    expect(wrapper.find('[data-testid="recommendation-needs-selection"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('请先选择一组岗位');
    expect(wrapper.find('[data-testid="recommendation-generate"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="recommendation-load-latest"]').exists()).toBe(false);
    // 候选对比区尚未展开。
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(false);
  });

  it('V8-5 推荐入口可发现性：选中关系后立即显示生成/加载按钮，标题为「本组岗位建议（0–8 条）」', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="recommendation-needs-selection"]').exists()).toBe(false);
    // 两个入口按钮立即可见，无需下滑。
    expect(wrapper.find('[data-testid="recommendation-generate"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="recommendation-load-latest"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('本组岗位建议（0–8 条）');
  });

  it('V8-5 推荐面板位于候选对比区之前（DOM 顺序先于候选详情）', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    const html = wrapper.html();
    const panelAt = html.indexOf('recommendation-panel-review');
    const compareAt = html.indexOf('candidate-compare');
    expect(panelAt).toBeGreaterThan(-1);
    expect(compareAt).toBeGreaterThan(-1);
    // 入口在候选详情之前渲染：可发现性的核心断言。
    expect(panelAt).toBeLessThan(compareAt);
  });

  it('V8-5.5 状态 Tag 中文化：关系状态与决策类型显示中文，技术码降级保留', async () => {
    setupHappy({}, [{
      snapshotId: 'snap-z', candidateId: 'cand-A', activeCandidateVersionId: 'ver-A',
      decisionType: 'material_change', analysisEligible: true, blockingIssues: [],
      needsConfirmation: [], conflictReason: null, changedFieldPaths: ['salaryMinK'], summary: summary('越迁软件'),
    }]);
    const wrapper = await mountPage();
    // 关系列表：中文状态可见，原技术码仍在 DOM（降级为弱化副文本，便于排查与既有断言）。
    expect(wrapper.text()).toContain('疑似重复');
    expect(wrapper.find('[data-testid="relation-list"]').text()).toContain('suspected_duplicate');
    // feed：决策类型中文化。
    expect(wrapper.find('[data-testid="decision-feed"]').text()).toContain('实质变化');
  });

  it('V8-5.5 候选 A/B 为两张等宽卡（结构对称）', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    const a = wrapper.find('[data-testid="candidate-card-low"]');
    const b = wrapper.find('[data-testid="candidate-card-high"]');
    expect(a.exists()).toBe(true);
    expect(b.exists()).toBe(true);
    // 两侧同为 cand-card，等宽由 .compare 的 1fr 1fr 栅格保证。
    expect(a.classes()).toContain('cand-card');
    expect(b.classes()).toContain('cand-card');
  });

  it('V8-5.5 顶部两列限高内部滚动 + 内部标识默认折叠', async () => {
    setupHappy({}, [{
      snapshotId: 'snap-y', candidateId: 'cand-A', activeCandidateVersionId: 'ver-A',
      decisionType: 'material_change', analysisEligible: true, blockingIssues: [],
      needsConfirmation: [], conflictReason: null, changedFieldPaths: [], summary: summary('越迁软件'),
    }]);
    mocks.listRuleEvidence.mockResolvedValue([{
      assessmentId: 'a1', ruleKey: 'salary_ceiling', evidenceState: 'structured', corruptReason: null,
      overrideState: 'none', originalResult: 'hit', evidenceHashShort: 'cafebabe0022',
      overrideAudit: [], matchedFieldPath: 'salaryMaxK', rawValue: '25K', normalizedValue: '25',
      confidence: 0.9, outcome: 'block', excerpt: null, explanation: null,
      ruleId: 'rule-1', ruleVersion: 'v1', blocking: true, matchedText: null,
    }] satisfies RuleEvidenceView[]);
    const wrapper = await mountPage();
    // 顶部两列列表挂 scroll-pane（限高 + overflow-y:auto）。
    expect(wrapper.find('[data-testid="relation-list"]').classes()).toContain('scroll-pane');
    expect(wrapper.find('[data-testid="decision-feed"]').classes()).toContain('scroll-pane');
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    // 证据内部 ID/哈希收进 details（默认折叠），文本仍留在 DOM 中。
    const details = wrapper.findAll('details.tech-details');
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]!.attributes('open')).toBeUndefined();
    expect(wrapper.find('[data-testid^="evidence-original-"]').exists()).toBe(true);
  });

  it('V8-5.5 推荐区标记为主决策区（primary-zone）', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-panel-review"]').classes()).toContain('primary-zone');
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

  it('选中关系展示结构化 signals 列表（含字段/双方值/说明）', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(mocks.getRelationDetail).toHaveBeenCalledWith('rel-1');
    expect(wrapper.find('[data-testid="signals-list"]').exists()).toBe(true);
    const sig = wrapper.find('[data-testid="signal-company_name_similar"]');
    expect(sig.exists()).toBe(true);
    expect(sig.text()).toContain('company');
    expect(sig.text()).toContain('公司名高度相似');
  });

  it('signals 损坏态渲染 corrupt 提示而非静默', async () => {
    setupHappy({}, [], { signals: { state: 'corrupt', signals: [], corruptReason: 'signals_json 未通过校验' } });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    const alert = wrapper.find('[data-testid="signals-corrupt"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('signals_json 未通过校验');
  });

  it('已确认不同的关系仍可查看裁决原因与审计时间线（可重开历史）', async () => {
    setupHappy({ status: 'confirmed_distinct' }, [], {
      status: 'confirmed_distinct', decidedAt: 9000, decisionReason: '两家为不同法人主体',
      auditTimeline: [{
        actionId: 'act-1', actionType: 'duplicate_rejected', reason: '两家为不同法人主体',
        evidenceReason: null, previousStatus: 'suspected_duplicate', resultingStatus: 'confirmed_distinct',
        occurredAt: 9000, reverted: false,
      }],
    });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="relation-decision-reason"]').text()).toContain('两家为不同法人主体');
    const timeline = wrapper.find('[data-testid="relation-audit-timeline"]');
    expect(timeline.exists()).toBe(true);
    expect(wrapper.find('[data-testid="relation-audit-duplicate_rejected"]').exists()).toBe(true);
  });

  it('状态筛选切到已确认不同时按对应状态重新查询', async () => {
    setupHappy();
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="filter-confirmed_distinct"]').trigger('click');
    await flushPromises();
    expect(mocks.listRelations).toHaveBeenLastCalledWith(['confirmed_distinct']);
  });

  it('规则证据展示原评估只读标识 + 不可变说明 + override 审计（append-only）', async () => {
    setupHappy();
    mocks.listRuleEvidence.mockResolvedValue([{
      assessmentId: 'a9', ruleKey: 'salary_ceiling', evidenceState: 'structured', corruptReason: null,
      overrideState: 'none', originalResult: 'hit', evidenceHashShort: 'deadbeef0011',
      overrideAudit: [
        { actionId: 's1', actionType: 'rule_override_set', reason: '可接受', overriddenValue: 'pass', previousOverrideState: 'none', resultingOverrideState: 'pass', occurredAt: 100, reverted: true },
        { actionId: 'r1', actionType: 'rule_override_reverted', reason: '恢复默认', overriddenValue: null, previousOverrideState: 'pass', resultingOverrideState: 'none', occurredAt: 200, reverted: false },
      ],
      ruleId: 'salary_ceiling', ruleVersion: 'v1', outcome: 'matched', matchedFieldPath: 'salaryMaxK',
      rawValue: '35', normalizedValue: 35, excerpt: '摘要', explanation: '说明', confidence: 0.9, blocking: false, matchedText: '35K',
    }] as RuleEvidenceView[]);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="evidence-original-a9"]').text()).toContain('deadbeef0011');
    expect(wrapper.find('[data-testid="evidence-immutable-a9"]').text()).toContain('原始规则评估未被覆盖操作修改');
    const audit = wrapper.find('[data-testid="override-audit-a9"]');
    expect(audit.exists()).toBe(true);
    expect(audit.text()).toContain('设置覆盖');
    expect(audit.text()).toContain('撤销覆盖');
  });

  it('规则证据区分 structured / legacy_scalar / corrupt 三态', async () => {
    setupHappy();
    const evidence: RuleEvidenceView[] = [
      { assessmentId: 'a1', ruleKey: 'salary_floor', evidenceState: 'structured', corruptReason: null, overrideState: 'none', originalResult: 'hit', evidenceHashShort: 'abc123def456', overrideAudit: [], ruleId: 'salary_floor', ruleVersion: 'v1', outcome: 'matched', matchedFieldPath: 'salaryMinK', rawValue: '20', normalizedValue: 20, excerpt: '摘要', explanation: '说明', confidence: 0.9, blocking: true, matchedText: '20K' },
      { assessmentId: 'a2', ruleKey: 'city', evidenceState: 'legacy_scalar', corruptReason: null, overrideState: 'none', originalResult: 'miss', evidenceHashShort: null, overrideAudit: [], ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null, rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null, matchedText: '苏州' },
      { assessmentId: 'a3', ruleKey: 'commute', evidenceState: 'corrupt', corruptReason: 'schema mismatch', overrideState: 'none', originalResult: 'hit', evidenceHashShort: null, overrideAudit: [], ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null, rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null, matchedText: null },
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
