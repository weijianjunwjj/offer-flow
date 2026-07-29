/**
 * V8-UX 主线整合：评审页导航接线测试。
 *
 * 覆盖：三阶段步骤条 + 三问引导条 + 单一主 CTA 的存在与行为；
 * 晋升成功后的 track 出口按 jobId 路由到岗位详情 / 岗位台账。
 * 用真实 memory router 并监视 push，走真实事件契约（recommend→promote→track）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import type { CandidateDecisionDetail, RelationDetail, RelationListItem, RelationSignals } from '../api/radarReviewApi';
import RadarReviewPage from './RadarReviewPage.vue';
import RadarRecommendationPanel from '../components/radar/RadarRecommendationPanel.vue';
import RadarPromotionPanel from '../components/radar/RadarPromotionPanel.vue';

const mocks = vi.hoisted(() => ({
  listRelations: vi.fn(), getRelationDetail: vi.fn(), listDecisionFeed: vi.fn(),
  getCandidateDetail: vi.fn(), listRuleEvidence: vi.fn(),
  confirmSame: vi.fn(), confirmDistinct: vi.fn(), revert: vi.fn(), requestRecheck: vi.fn(),
  setOverride: vi.fn(), revertOverride: vi.fn(),
}));
vi.mock('../api/radarReviewApi', () => ({ radarReviewApi: mocks }));

const featureFlags = vi.hoisted(() => ({ radarAnalysisEnabled: false, radarRecommendationsEnabled: false }));
vi.mock('../config/features', () => ({ features: featureFlags }));
vi.mock('../api/radarRecommendationApi', () => ({
  radarRecommendationApi: { createBatch: vi.fn(), listRecentBatches: vi.fn().mockResolvedValue([]), getBatch: vi.fn() },
}));
const actionMocks = vi.hoisted(() => ({ getView: vi.fn(), apply: vi.fn(), revert: vi.fn() }));
vi.mock('../api/radarActionApi', async (importActual) => {
  const actual = await importActual<typeof import('../api/radarActionApi')>();
  return { ...actual, radarActionApi: actionMocks };
});

function presentSignals(): RelationSignals {
  return { state: 'present', signals: [], corruptReason: null };
}
function summary(company: string) {
  return {
    candidateId: `cand-${company}`, activeCandidateVersionId: `ver-${company}`,
    company, role: '前端工程师', city: '苏州', salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月',
    experienceRequirement: '3-5年', educationRequirement: '本科', jdExcerpt: 'JD',
    normalizedSourceUrl: 'https://x/y.html', sourceDomain: null,
  };
}
function relation(over: Partial<RelationListItem> = {}): RelationListItem {
  return {
    relationId: 'rel-1', candidateIdLow: 'cand-A', candidateIdHigh: 'cand-B',
    status: 'suspected_duplicate', reasonCode: 'same_company_role', signals: presentSignals(),
    firstDetectedAt: 1000, lastDetectedAt: 2000,
    lowSummary: summary('A公司'), highSummary: summary('B公司'), hasPriorDecision: false, ...over,
  };
}
function relationDetail(): RelationDetail {
  return {
    relationId: 'rel-1', candidateIdLow: 'cand-A', candidateIdHigh: 'cand-B',
    status: 'suspected_duplicate', reasonCode: 'same_company_role', decisionReason: null,
    signals: presentSignals(), firstDetectedAt: 1000, lastDetectedAt: 2000, decidedAt: null,
    lowSummary: summary('A公司'), highSummary: summary('B公司'), auditTimeline: [],
  };
}
function detail(over: Partial<CandidateDecisionDetail> = {}): CandidateDecisionDetail {
  return {
    candidateId: 'cand-A', activeCandidateVersionId: 'ver-A', decisionType: 'material_change',
    analysisEligible: true, blockingIssues: [], needsConfirmation: [], conflictReason: null,
    changedFields: [], latestSnapshotId: 'snap-1',
    currentVersion: summary('A公司'), previousVersion: summary('A公司'), sourceLinks: [], ...over,
  };
}
function setupHappy(): void {
  mocks.listRelations.mockResolvedValue([relation()]);
  mocks.getRelationDetail.mockResolvedValue(relationDetail());
  mocks.listDecisionFeed.mockResolvedValue([]);
  mocks.getCandidateDetail.mockResolvedValue(detail());
  mocks.listRuleEvidence.mockResolvedValue([]);
}

const Blank = { template: '<div />' };
function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/radar/import', name: 'radar-import', component: Blank },
      { path: '/radar/review', name: 'radar-review', component: RadarReviewPage },
      { path: '/jobs', name: 'jobs', component: Blank },
      { path: '/jobs/:jobId', name: 'job-detail', component: Blank },
    ],
  });
  router.push('/radar/review');
  return router;
}

async function mountPage() {
  const router = makeRouter();
  await router.isReady();
  const push = vi.spyOn(router, 'push');
  const wrapper = mount(RadarReviewPage, {
    global: { plugins: [router], stubs: { teleport: true } },
  });
  await flushPromises();
  return { wrapper, push };
}

beforeEach(() => {
  actionMocks.getView.mockImplementation((candidateId: string) => Promise.resolve({
    candidateId, activeCandidateVersionId: `ver-${candidateId}`,
    state: { saved: false, ignored: false, priority: false, appliedPending: false }, history: [],
  }));
});
afterEach(() => {
  vi.clearAllMocks();
  featureFlags.radarAnalysisEnabled = false;
  featureFlags.radarRecommendationsEnabled = false;
});

describe('RadarReviewPage 主线接线', () => {
  it('渲染步骤条（review 高亮）、三问引导条与单一主 CTA', async () => {
    setupHappy();
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="radar-stage-stepper"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="radar-stage-review"]').classes()).toContain('is-active');
    expect(wrapper.find('[data-testid="radar-guide-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="radar-next-action"]').exists()).toBe(true);
  });

  it('步骤条点击 collect / promote 路由到采集页 / 岗位台账', async () => {
    setupHappy();
    const { wrapper, push } = await mountPage();
    await wrapper.find('[data-testid="radar-stage-collect"]').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'radar-import' });
    await wrapper.find('[data-testid="radar-stage-promote"]').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'jobs' });
  });

  it('未选关系时主 CTA「选择下一组」打开首条关系', async () => {
    setupHappy();
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(false);
    await wrapper.find('[data-testid="radar-next-action-cta"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="candidate-compare"]').exists()).toBe(true);
  });

  it('晋升 track 事件：带 jobId 去岗位详情', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const { wrapper, push } = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    // 选中某条建议以打开晋升面板（走真实 @promote 契约）
    wrapper.findComponent(RadarRecommendationPanel).vm.$emit('promote', 'ver-A公司');
    await flushPromises();
    const promo = wrapper.findComponent(RadarPromotionPanel);
    expect(promo.exists()).toBe(true);
    promo.vm.$emit('track', { jobId: 'job-123', applicationId: 'app-1' });
    await flushPromises();
    expect(push).toHaveBeenCalledWith({ name: 'job-detail', params: { jobId: 'job-123' } });
  });

  it('晋升 track 事件：无 jobId 回岗位台账', async () => {
    featureFlags.radarRecommendationsEnabled = true;
    setupHappy();
    const { wrapper, push } = await mountPage();
    await wrapper.find('[data-testid="relation-rel-1"]').trigger('click');
    await flushPromises();
    wrapper.findComponent(RadarRecommendationPanel).vm.$emit('promote', 'ver-A公司');
    await flushPromises();
    wrapper.findComponent(RadarPromotionPanel).vm.$emit('track', { jobId: null, applicationId: 'app-1' });
    await flushPromises();
    expect(push).toHaveBeenCalledWith({ name: 'jobs' });
  });
});
