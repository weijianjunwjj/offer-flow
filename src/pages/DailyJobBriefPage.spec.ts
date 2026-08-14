import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  DailyJobBrief,
  DailyJobBriefDiscoveryItem,
  DailyJobBriefRecommendationItem,
  SearchCoverage,
} from '../api/dailyJobBriefApi';
import type { RecommendationBatchView } from '../api/radarRecommendationApi';
import DailyJobBriefPage from './DailyJobBriefPage.vue';

const mocks = vi.hoisted(() => ({
  today: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../api/dailyJobBriefApi', () => ({ dailyJobBriefApi: mocks }));

const COVERAGE: SearchCoverage = {
  queriesCompleted: 4,
  queriesFailed: 0,
  failedScopes: [],
  queryResults: [{ queryKey: '苏州×前端', status: 'COMPLETED', resultsReturned: 5 }],
};

function brief(overrides: Partial<DailyJobBrief> = {}): DailyJobBrief {
  return {
    id: 'b1', briefDate: '2026-08-14', searchPlanVersionId: 'spv1',
    searchPlan: { id: 'p1', name: '每日前端岗位', versionId: 'spv1' },
    sourceRunIds: ['sr1'], recommendationBatchId: 'rb1', discoveryItemIds: ['cv1'],
    status: 'READY', coverage: COVERAGE, costSummaryJson: null, emptyReason: null,
    generatedAt: 1755014400000, completedAt: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function recommendationItem(overrides: Partial<DailyJobBriefRecommendationItem> = {}): DailyJobBriefRecommendationItem {
  return {
    candidateId: 'c1', candidateVersionId: 'cv1', evidenceLevel: 'FULL_EVIDENCE',
    title: '高级前端工程师', company: '某科技有限公司', city: '苏州',
    sourceUrl: 'https://www.zhipin.com/job/123', sourceDomain: 'zhipin.com', provider: 'boss',
    kind: 'apply_now', priority: 1, confidence: 'high',
    rationale: '岗位方向与你的前端技能高度匹配。',
    evidenceRefs: [{ evidenceKey: 'skill_match', polarity: 'support' }],
    conditions: [],
    ...overrides,
  };
}

function batch(overrides: Partial<RecommendationBatchView> = {}): RecommendationBatchView {
  return {
    id: 'rb1', status: 'succeeded', candidateVersionIds: ['cv1'], selectedCandidateVersionIds: ['cv1'],
    recommendationSet: {
      contractVersion: 1,
      recommendations: [],
      blocked: [],
      emptyReason: null,
    },
    diagnosisStatus: 'formed', emptyReason: null, generatedAt: 0,
    ...overrides,
  };
}

function discoveryItem(overrides: Partial<DailyJobBriefDiscoveryItem> = {}): DailyJobBriefDiscoveryItem {
  return {
    candidateId: 'c2', candidateVersionId: 'cv2', evidenceLevel: 'MANUAL_REVIEW_REQUIRED',
    title: '高级前端开发工程师', company: '某科技有限公司', city: '苏州',
    sourceUrl: 'https://www.zhipin.com/job/123', sourceDomain: 'zhipin.com', provider: 'tavily',
    ...overrides,
  };
}

interface BriefDetail {
  recommendationBatch?: RecommendationBatchView | null;
  recommendationItems?: DailyJobBriefRecommendationItem[];
  discoveryItems?: DailyJobBriefDiscoveryItem[];
}

/** 按 brief id 提供详情，支持多简报各自独立内容（跨简报不混合）。 */
function stubToday(
  briefs: DailyJobBrief[],
  detailFor: (id: string) => BriefDetail = () => ({}),
): void {
  mocks.today.mockResolvedValue({ briefDate: briefs[0]?.briefDate ?? '2026-08-14', briefs, total: briefs.length });
  mocks.get.mockImplementation(async (id: string) => {
    const target = briefs.find((b) => b.id === id);
    if (target === undefined) throw new ApiError('Not Found', 404, { code: 'NOT_FOUND', message: 'Not Found' });
    const detail = detailFor(id);
    return {
      brief: target,
      recommendationBatch: detail.recommendationBatch ?? null,
      recommendationItems: detail.recommendationItems ?? [],
      discoveryItems: detail.discoveryItems ?? [],
    };
  });
}

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(DailyJobBriefPage);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('DailyJobBriefPage · 今日简报加载', () => {
  it('加载今日简报并展示推荐与发现', async () => {
    stubToday([brief()], () => ({ recommendationBatch: batch(), recommendationItems: [recommendationItem()], discoveryItems: [discoveryItem()] }));
    const wrapper = await mountPage();

    expect(mocks.today).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('b1');
    expect(wrapper.find('[data-testid="brief-today"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="brief-date"]').text()).toContain('2026-08-14');
    expect(wrapper.find('[data-testid="recommendation-item-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(true);
  });

  it('今日无简报 → 展示明确空态（A）', async () => {
    stubToday([]);
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="no-brief"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('今天还没有生成每日求职简报');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('多 run 投影：sourceRunIds 数量正确展示运行次数', async () => {
    stubToday([brief({ sourceRunIds: ['sr1', 'sr2', 'sr3'] })], () => ({ recommendationBatch: batch(), recommendationItems: [recommendationItem()] }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="source-run-count"]').text()).toContain('3 次');
  });

  it('搜索覆盖情况正确展示查询完成数', async () => {
    stubToday([brief({ coverage: { ...COVERAGE, queriesCompleted: 7, queriesFailed: 1, queryResults: [COVERAGE.queryResults[0]!, { queryKey: 'x', status: 'FAILED' as const, resultsReturned: 0 }] } })], () => ({ recommendationBatch: batch(), recommendationItems: [recommendationItem()] }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="coverage"]').text()).toContain('7 次');
    expect(wrapper.find('[data-testid="coverage"]').text()).toContain('1 次');
  });
});

describe('DailyJobBriefPage · 推荐批次', () => {
  it('正式推荐显示岗位名 / 公司 / 城市 / 证据等级', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch(),
      recommendationItems: [recommendationItem({ priority: 1, kind: 'apply_now' })],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-title"]').text()).toContain('高级前端工程师');
    expect(wrapper.find('[data-testid="recommendation-company"]').text()).toContain('某科技有限公司');
    expect(wrapper.text()).toContain('苏州');
    expect(wrapper.find('[data-testid="recommendation-evidence-level"]').text()).toContain('完整证据');
  });

  it('非空推荐展示 kind / 置信度 / 理由 / 证据', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch(),
      recommendationItems: [recommendationItem({ priority: 1, kind: 'apply_now' })],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-count"]').text()).toContain('1 条推荐');
    expect(wrapper.find('[data-testid="recommendation-kind"]').text()).toContain('建议立即投递');
    expect(wrapper.find('[data-testid="recommendation-confidence"]').text()).toContain('高');
    expect(wrapper.find('[data-testid="recommendation-rationale"]').text()).toContain('前端技能高度匹配');
  });

  it('推荐项有 sourceUrl → 展示「查看岗位来源」新窗口链接', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch(),
      recommendationItems: [recommendationItem({ sourceUrl: 'https://www.zhipin.com/job/123' })],
    }));
    const wrapper = await mountPage();
    const link = wrapper.find('[data-testid="recommendation-source-link"]');
    expect(link.exists()).toBe(true);
    expect(link.attributes('href')).toBe('https://www.zhipin.com/job/123');
    expect(link.attributes('target')).toBe('_blank');
  });

  it('推荐项无 sourceUrl → 不制造来源按钮', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch(),
      recommendationItems: [recommendationItem({ sourceUrl: null, sourceDomain: null })],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-source-link"]').exists()).toBe(false);
  });

  it('显式空推荐批次（0 条 + emptyReason）展示原因，不报错', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_current_successful_analysis' } }),
      recommendationItems: [],
      discoveryItems: [discoveryItem()],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('无当前有效的成功分析');
  });

  it('完全空批（推荐 0 + 无 discovery + brief.emptyReason）', async () => {
    stubToday([brief({ emptyReason: '今天未执行搜索，无候选进入评估。' })], () => ({
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_candidates_in_scope' } }),
      recommendationItems: [],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="fully-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('今天未执行搜索');
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(false);
  });
});

describe('DailyJobBriefPage · Discovery', () => {
  it('展示 discovery 条目（标题 / 公司 / 城市 / 证据等级 / 来源）', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_current_successful_analysis' } }),
      recommendationItems: [],
      discoveryItems: [discoveryItem()],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="discovery-count"]').text()).toContain('1 条发现');
    expect(wrapper.find('[data-testid="discovery-title"]').text()).toContain('高级前端开发工程师');
    expect(wrapper.find('[data-testid="discovery-company"]').text()).toContain('某科技有限公司');
    expect(wrapper.find('[data-testid="discovery-evidence-level"]').text()).toContain('需人工确认');
    expect(wrapper.find('[data-testid="discovery-source-url"]').text()).toContain('zhipin.com');
  });

  it('推荐 0 但有 discovery：不显示完全空批，显示推荐空态 + 发现区', async () => {
    stubToday([brief()], () => ({
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'all_candidates_excluded' } }),
      recommendationItems: [],
      discoveryItems: [discoveryItem(), discoveryItem({ candidateId: 'c3', candidateVersionId: 'cv3' })],
    }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="fully-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="discovery-count"]').text()).toContain('2 条发现');
  });
});

describe('DailyJobBriefPage · 多简报 selector 与切换', () => {
  it('total=1 → 不显示 selector', async () => {
    stubToday([brief()], () => ({ recommendationBatch: batch(), recommendationItems: [recommendationItem()] }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="brief-selector"]').exists()).toBe(false);
  });

  it('total=2 → 两份都可见，展示 plan name 而非 UUID', async () => {
    const b1 = brief({ id: 'b1', searchPlan: { id: 'p1', name: '每日前端岗位', versionId: 'v1' } });
    const b2 = brief({ id: 'b2', searchPlan: { id: 'p2', name: '后端岗位计划', versionId: 'v2' } });
    stubToday([b1, b2], () => ({ recommendationBatch: batch(), recommendationItems: [] }));
    const wrapper = await mountPage();
    const selector = wrapper.find('[data-testid="brief-selector"]');
    expect(selector.exists()).toBe(true);
    expect(selector.text()).toContain('每日前端岗位');
    expect(selector.text()).toContain('后端岗位计划');
    expect(selector.text()).not.toContain('b1');
    expect(selector.text()).not.toContain('b2');
  });

  it('默认选择第一份（deterministic）', async () => {
    const b1 = brief({ id: 'b1', searchPlan: { id: 'p1', name: '计划A', versionId: 'v1' } });
    const b2 = brief({ id: 'b2', searchPlan: { id: 'p2', name: '计划B', versionId: 'v2' } });
    stubToday([b1, b2], () => ({ recommendationBatch: batch(), recommendationItems: [] }));
    await mountPage();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('b1');
  });

  it('切换简报 → 加载正确 detail，且不跨简报污染推荐', async () => {
    const b1 = brief({ id: 'b1', searchPlan: { id: 'p1', name: '计划A', versionId: 'v1' } });
    const b2 = brief({ id: 'b2', searchPlan: { id: 'p2', name: '计划B', versionId: 'v2' } });
    stubToday([b1, b2], (id) => id === 'b1'
      ? { recommendationBatch: batch(), recommendationItems: [recommendationItem({ candidateId: 'c1', title: '前端岗位', priority: 1 })], discoveryItems: [] }
      : { recommendationBatch: batch(), recommendationItems: [recommendationItem({ candidateId: 'c2', title: '后端岗位', priority: 1 })], discoveryItems: [] });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-title"]').text()).toContain('前端岗位');

    await wrapper.find('[data-testid="brief-selector-b2"]').trigger('click');
    await flushPromises();

    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenLastCalledWith('b2');
    expect(wrapper.find('[data-testid="recommendation-title"]').text()).toContain('后端岗位');
    expect(wrapper.find('[data-testid="recommendation-title"]').text()).not.toContain('前端岗位');
  });

  it('切换简报 → discovery 不跨简报污染', async () => {
    const b1 = brief({ id: 'b1', searchPlan: { id: 'p1', name: '计划A', versionId: 'v1' } });
    const b2 = brief({ id: 'b2', searchPlan: { id: 'p2', name: '计划B', versionId: 'v2' } });
    stubToday([b1, b2], (id) => id === 'b1'
      ? { recommendationBatch: batch(), recommendationItems: [], discoveryItems: [discoveryItem({ candidateId: 'c2', title: '前端发现' })] }
      : { recommendationBatch: batch(), recommendationItems: [], discoveryItems: [discoveryItem({ candidateId: 'c9', title: '后端发现' })] });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="discovery-title"]').text()).toContain('前端发现');

    await wrapper.find('[data-testid="brief-selector-b2"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="discovery-title"]').text()).toContain('后端发现');
    expect(wrapper.find('[data-testid="discovery-title"]').text()).not.toContain('前端发现');
  });
});

describe('DailyJobBriefPage · 健壮性与交互', () => {
  it('costSummary=null 不报错并展示占位文案', async () => {
    stubToday([brief({ costSummaryJson: null })], () => ({ recommendationBatch: batch(), recommendationItems: [] }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="cost-null"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cost-null"]').text()).toContain('尚未计算');
  });

  it('API 错误展示后端错误信息', async () => {
    mocks.today.mockRejectedValue(new ApiError('服务器内部错误', 500, { code: 'INTERNAL_ERROR', message: '服务器内部错误' }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="page-error"]').text()).toContain('服务器内部错误');
  });

  it('能力未启用（404）展示可理解的未启用提示', async () => {
    mocks.today.mockRejectedValue(new ApiError('Not Found', 404, { code: 'NOT_FOUND', message: 'Not Found' }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="capability-unavailable"]').text()).toContain('每日求职简报能力当前未启用');
  });

  it('点击刷新重新调用 today 与 get', async () => {
    stubToday([brief()], () => ({ recommendationBatch: batch(), recommendationItems: [] }));
    const wrapper = await mountPage();
    expect(mocks.today).toHaveBeenCalledTimes(1);

    await wrapper.find('[data-testid="refresh"]').trigger('click');
    await flushPromises();
    expect(mocks.today).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('只调用只读端点，不触发任何写操作', async () => {
    stubToday([brief()], () => ({ recommendationBatch: batch(), recommendationItems: [recommendationItem()], discoveryItems: [discoveryItem()] }));
    await mountPage();
    // 页面只暴露 list/today/get 三个只读方法；加载路径仅 today + get，无 POST/PATCH/DELETE。
    expect(mocks.today).toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
