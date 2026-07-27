import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type {
  RecommendationBatchView, RecommendationItem, BlockedCandidate,
  RecommendationEmptyReason,
} from '../../api/radarRecommendationApi';
import RadarRecommendationPanel from './RadarRecommendationPanel.vue';

const mocks = vi.hoisted(() => ({
  createBatch: vi.fn(),
  getBatch: vi.fn(),
  listRecentBatches: vi.fn(),
}));
vi.mock('../../api/radarRecommendationApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarRecommendationApi')>();
  return { ...actual, radarRecommendationApi: mocks };
});

let recCounter = 0;
function rec(over: Partial<RecommendationItem> = {}): RecommendationItem {
  recCounter += 1;
  return {
    candidateId: `cand-${recCounter}`, candidateVersionId: `cv-${recCounter}`, analysisRecordId: `rec-${recCounter}`,
    kind: 'apply_now', priority: recCounter, confidence: 'high', rationale: `理由${recCounter}`,
    evidenceRefs: [{ evidenceKey: `candidate:cv-${recCounter}:role`, polarity: 'support' }],
    conditions: ['verify_before_apply'], ...over,
  };
}
function blocked(reason: BlockedCandidate['reason'], over: Partial<BlockedCandidate> = {}): BlockedCandidate {
  return { candidateId: 'cand-b', candidateVersionId: 'cv-b', analysisRecordId: null, reason, ...over };
}
function batch(
  recommendations: RecommendationItem[],
  opts: { blocked?: BlockedCandidate[]; emptyReason?: RecommendationEmptyReason | null; id?: string } = {},
): RecommendationBatchView {
  const emptyReason = recommendations.length === 0 ? (opts.emptyReason ?? 'all_candidates_excluded') : null;
  return {
    id: opts.id ?? 'batch-1', status: 'succeeded',
    candidateVersionIds: recommendations.map((r) => r.candidateVersionId),
    selectedCandidateVersionIds: recommendations.map((r) => r.candidateVersionId),
    recommendationSet: { contractVersion: 1, recommendations, blocked: opts.blocked ?? [], emptyReason },
    diagnosisStatus: 'insufficient_evidence', emptyReason, generatedAt: 1_800_000_000,
  };
}

function mountPanel(over: Record<string, unknown> = {}) {
  return mount(RadarRecommendationPanel, {
    props: { candidateVersionIds: ['cv-1', 'cv-2'], enabled: true, ...over },
    global: { stubs: { teleport: true } },
  });
}

beforeEach(() => {
  recCounter = 0;
  mocks.createBatch.mockReset();
  mocks.getBatch.mockReset();
  mocks.listRecentBatches.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('RadarRecommendationPanel 门禁与操作', () => {
  it('未开启：只显示提示，不渲染任何操作按钮', () => {
    const w = mountPanel({ enabled: false });
    expect(w.find('[data-testid="recommendation-disabled"]').exists()).toBe(true);
    expect(w.find('[data-testid="recommendation-generate"]').exists()).toBe(false);
    expect(mocks.createBatch).not.toHaveBeenCalled();
  });

  it('scope 为空：生成按钮禁用并提示无候选', async () => {
    const w = mountPanel({ candidateVersionIds: [] });
    expect(w.find('[data-testid="recommendation-no-scope"]').exists()).toBe(true);
    expect(w.find('[data-testid="recommendation-generate"]').attributes('disabled')).toBeDefined();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    expect(mocks.createBatch).not.toHaveBeenCalled();
  });

  it('生成批次去重且排序 scope 后调用 createBatch', async () => {
    mocks.createBatch.mockResolvedValue(batch([rec()]));
    const w = mountPanel({ candidateVersionIds: ['cv-2', 'cv-1', 'cv-2'] });
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(mocks.createBatch).toHaveBeenCalledTimes(1);
    expect(mocks.createBatch).toHaveBeenCalledWith(['cv-1', 'cv-2']);
  });
});

describe('RadarRecommendationPanel 结果展示', () => {
  it('0 条：显示 emptyReason 与原因码', async () => {
    mocks.createBatch.mockResolvedValue(batch([], { emptyReason: 'no_current_successful_analysis' }));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-empty"]').exists()).toBe(true);
    expect(w.find('[data-testid="recommendation-empty-reason-code"]').text()).toContain('no_current_successful_analysis');
    expect(w.find('[data-testid="recommendation-item-1"]').exists()).toBe(false);
  });

  it('1 条：展示优先级/类型/置信度/理由/条件/证据', async () => {
    mocks.createBatch.mockResolvedValue(batch([
      rec({ kind: 'stretch', confidence: 'medium', rationale: '值得一冲', conditions: ['stretch_reach'] }),
    ]));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-count"]').text()).toContain('共 1 条');
    expect(w.find('[data-testid="recommendation-priority"]').text()).toBe('#1');
    expect(w.find('[data-testid="recommendation-kind"]').text()).toContain('冲刺机会');
    expect(w.find('[data-testid="recommendation-confidence"]').text()).toContain('中');
    expect(w.find('[data-testid="recommendation-rationale"]').text()).toBe('值得一冲');
    expect(w.find('[data-testid="recommendation-conditions"]').text()).toContain('需够一够');
    expect(w.find('[data-testid="recommendation-evidence-support"]').exists()).toBe(true);
  });

  it('8 条：全部渲染（上限）', async () => {
    const items = Array.from({ length: 8 }, (_, i) => rec({ priority: i + 1 }));
    mocks.createBatch.mockResolvedValue(batch(items));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-count"]').text()).toContain('共 8 条');
    expect(w.findAll('[class="rec-item"]').length).toBe(8);
    expect(w.find('[data-testid="recommendation-item-8"]').exists()).toBe(true);
  });

  it('按 priority 升序稳定排序（即便后端乱序返回）', async () => {
    const shuffled = [
      rec({ candidateVersionId: 'cv-c', priority: 3 }),
      rec({ candidateVersionId: 'cv-a', priority: 1 }),
      rec({ candidateVersionId: 'cv-b', priority: 2 }),
    ];
    mocks.createBatch.mockResolvedValue(batch(shuffled));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    const priorities = w.findAll('[data-testid="recommendation-priority"]').map((n) => n.text());
    expect(priorities).toEqual(['#1', '#2', '#3']);
  });

  it('被排除候选：逐条展示阻断原因（即便有建议）', async () => {
    mocks.createBatch.mockResolvedValue(batch([rec()], {
      blocked: [blocked('hard_constraint_hit'), blocked('ignored_unchanged', { candidateVersionId: 'cv-x' })],
    }));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-blocked"]').text()).toContain('被排除的候选（2）');
    expect(w.find('[data-testid="recommendation-blocked-hard_constraint_hit"]').text()).toContain('命中硬性约束');
    expect(w.find('[data-testid="recommendation-blocked-ignored_unchanged"]').text()).toContain('已忽略且未变化');
  });
});

describe('RadarRecommendationPanel 加载最新与健壮性', () => {
  it('加载最新批次：取列表首条', async () => {
    mocks.listRecentBatches.mockResolvedValue([batch([rec()], { id: 'batch-latest' }), batch([rec()], { id: 'batch-old' })]);
    const w = mountPanel();
    await w.find('[data-testid="recommendation-load-latest"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-meta"]').text()).toContain('batch-latest');
  });

  it('加载最新批次为空列表：提示暂无历史', async () => {
    mocks.listRecentBatches.mockResolvedValue([]);
    const w = mountPanel();
    await w.find('[data-testid="recommendation-load-latest"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-error"]').text()).toContain('暂无历史推荐批次');
  });

  it('防重复点击：生成期间不重复发起 createBatch', async () => {
    let resolve!: (v: RecommendationBatchView) => void;
    mocks.createBatch.mockReturnValue(new Promise((r) => { resolve = r; }));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    expect(mocks.createBatch).toHaveBeenCalledTimes(1);
    resolve(batch([rec()]));
    await flushPromises();
  });

  it('迟到响应污染防护：scope 切换后旧响应被丢弃', async () => {
    let resolveOld!: (v: RecommendationBatchView) => void;
    mocks.createBatch.mockReturnValueOnce(new Promise((r) => { resolveOld = r; }));
    const w = mountPanel({ candidateVersionIds: ['cv-1'] });
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    // 切换 scope（Candidate 切换）→ 作废进行中请求
    await w.setProps({ candidateVersionIds: ['cv-9'] });
    resolveOld(batch([rec({ candidateVersionId: 'cv-1' })], { id: 'batch-old' }));
    await flushPromises();
    // 旧响应被丢弃：不展示任何结果
    expect(w.find('[data-testid="recommendation-result"]').exists()).toBe(false);
  });

  it('Candidate 切换清理：已展示批次在 scope 变化后清空', async () => {
    mocks.createBatch.mockResolvedValue(batch([rec()]));
    const w = mountPanel({ candidateVersionIds: ['cv-1'] });
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-result"]').exists()).toBe(true);
    await w.setProps({ candidateVersionIds: ['cv-2'] });
    expect(w.find('[data-testid="recommendation-result"]').exists()).toBe(false);
  });

  it('createBatch 报错：显示安全错误文案', async () => {
    mocks.createBatch.mockRejectedValue(new ApiError('推荐 scope 超过上限 50', 400));
    const w = mountPanel();
    await w.find('[data-testid="recommendation-generate"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="recommendation-error"]').text()).toContain('推荐 scope 超过上限 50');
  });
});
