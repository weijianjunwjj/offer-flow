import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  DailyJobBrief,
  DailyJobBriefDiscoveryItem,
  SearchCoverage,
} from '../api/dailyJobBriefApi';
import type { RecommendationBatchView, RecommendationItem } from '../api/radarRecommendationApi';
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
    sourceRunIds: ['sr1'], recommendationBatchId: 'rb1', discoveryItemIds: ['cv1'],
    status: 'READY', coverage: COVERAGE, costSummaryJson: null, emptyReason: null,
    generatedAt: 1755014400000, completedAt: null, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

function recommendationItem(overrides: Partial<RecommendationItem> = {}): RecommendationItem {
  return {
    candidateId: 'c1', candidateVersionId: 'cv1', analysisRecordId: 'ar1',
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
      recommendations: [recommendationItem()],
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

function stubTodayWith(briefs: DailyJobBrief[], detail?: { recommendationBatch: RecommendationBatchView | null; discoveryItems: DailyJobBriefDiscoveryItem[] }): void {
  mocks.today.mockResolvedValue({ briefDate: briefs[0]?.briefDate ?? '2026-08-14', briefs, total: briefs.length });
  mocks.get.mockImplementation(async (id: string) => {
    const target = briefs.find((b) => b.id === id);
    if (target === undefined) throw new ApiError('Not Found', 404, { code: 'NOT_FOUND', message: 'Not Found' });
    return {
      brief: target,
      recommendationBatch: detail?.recommendationBatch ?? null,
      discoveryItems: detail?.discoveryItems ?? [],
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
    stubTodayWith([brief()], { recommendationBatch: batch(), discoveryItems: [discoveryItem()] });
    const wrapper = await mountPage();

    expect(mocks.today).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith('b1');
    expect(wrapper.find('[data-testid="brief-today"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="brief-date"]').text()).toContain('2026-08-14');
    expect(wrapper.find('[data-testid="recommendation-item-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(true);
  });

  it('今日无简报 → 展示明确空态（A）', async () => {
    stubTodayWith([]);
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="no-brief"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('今天还没有生成每日求职简报');
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('多 run 投影：sourceRunIds 数量正确展示运行次数', async () => {
    stubTodayWith([brief({ sourceRunIds: ['sr1', 'sr2', 'sr3'] })], { recommendationBatch: batch(), discoveryItems: [] });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="source-run-count"]').text()).toContain('3 次');
  });

  it('搜索覆盖情况正确展示查询完成数', async () => {
    stubTodayWith([brief({ coverage: { ...COVERAGE, queriesCompleted: 7, queriesFailed: 1, queryResults: [COVERAGE.queryResults[0]!, { queryKey: 'x', status: 'FAILED' as const, resultsReturned: 0 }] } })], { recommendationBatch: batch(), discoveryItems: [] });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="coverage"]').text()).toContain('7 次');
    expect(wrapper.find('[data-testid="coverage"]').text()).toContain('1 次');
  });
});

describe('DailyJobBriefPage · 推荐批次', () => {
  it('非空推荐展示 kind / 置信度 / 理由 / 证据', async () => {
    stubTodayWith([brief()], {
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [recommendationItem({ priority: 1, kind: 'apply_now' })], blocked: [], emptyReason: null } }),
      discoveryItems: [],
    });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-count"]').text()).toContain('1 条推荐');
    expect(wrapper.find('[data-testid="recommendation-kind"]').text()).toContain('建议立即投递');
    expect(wrapper.find('[data-testid="recommendation-confidence"]').text()).toContain('高');
    expect(wrapper.find('[data-testid="recommendation-rationale"]').text()).toContain('前端技能高度匹配');
  });

  it('显式空推荐批次（0 条 + emptyReason）展示原因', async () => {
    stubTodayWith([brief()], {
      recommendationBatch: batch({
        recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_current_successful_analysis' },
      }),
      discoveryItems: [discoveryItem()],
    });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('无当前有效的成功分析');
  });

  it('完全空批（推荐 0 + 无 discovery + brief.emptyReason）', async () => {
    stubTodayWith([brief({ emptyReason: '今天未执行搜索，无候选进入评估。' })], {
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_candidates_in_scope' } }),
      discoveryItems: [],
    });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="fully-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('今天未执行搜索');
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(false);
  });
});

describe('DailyJobBriefPage · Discovery', () => {
  it('展示 discovery 条目（标题 / 公司 / 城市 / 证据等级 / 来源）', async () => {
    stubTodayWith([brief()], {
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'no_current_successful_analysis' } }),
      discoveryItems: [discoveryItem()],
    });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="discovery-count"]').text()).toContain('1 条发现');
    expect(wrapper.find('[data-testid="discovery-title"]').text()).toContain('高级前端开发工程师');
    expect(wrapper.find('[data-testid="discovery-company"]').text()).toContain('某科技有限公司');
    expect(wrapper.find('[data-testid="discovery-evidence-level"]').text()).toContain('需人工确认');
    expect(wrapper.find('[data-testid="discovery-source-url"]').text()).toContain('zhipin.com');
  });

  it('推荐 0 但有 discovery：不显示完全空批，显示推荐空态 + 发现区', async () => {
    stubTodayWith([brief()], {
      recommendationBatch: batch({ recommendationSet: { contractVersion: 1, recommendations: [], blocked: [], emptyReason: 'all_candidates_excluded' } }),
      discoveryItems: [discoveryItem(), discoveryItem({ candidateId: 'c3', candidateVersionId: 'cv3' })],
    });
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="recommendation-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="fully-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="discovery-section"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="discovery-count"]').text()).toContain('2 条发现');
  });
});

describe('DailyJobBriefPage · 健壮性与交互', () => {
  it('costSummary=null 不报错并展示占位文案', async () => {
    stubTodayWith([brief({ costSummaryJson: null })], { recommendationBatch: batch(), discoveryItems: [] });
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
    stubTodayWith([brief()], { recommendationBatch: batch(), discoveryItems: [] });
    const wrapper = await mountPage();
    expect(mocks.today).toHaveBeenCalledTimes(1);

    await wrapper.find('[data-testid="refresh"]').trigger('click');
    await flushPromises();
    expect(mocks.today).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('只调用只读端点，不触发任何写操作', async () => {
    stubTodayWith([brief()], { recommendationBatch: batch(), discoveryItems: [discoveryItem()] });
    await mountPage();
    // 页面只暴露 list/today/get 三个只读方法；加载路径仅 today + get，无 POST/PATCH/DELETE。
    expect(mocks.today).toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
