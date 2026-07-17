import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FunnelResult } from '../domain/funnel';
import MarketFunnelPage from './MarketFunnelPage.vue';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../api/funnelApi', () => ({ funnelApi: mocks }));

function emptyOverview(): FunnelResult['overview'] {
  return {
    stages: [
      { stage: 'applied', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'valid_reply', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'resume_requested', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'phone_screen', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'interview_scheduled', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'interview_completed', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'interview_advanced', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'offer_received', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
      { stage: 'offer_accepted', count: 0, conversionFromPrevious: null, conversionFromApplied: null },
    ],
    statusCounts: {
      in_progress: 0,
      stale: 0,
      paused_frozen: 0,
      rejected_by_recruiter: 0,
      user_withdrew: 0,
      position_closed: 0,
      offer_accepted: 0,
    },
    confidence: {
      counts: { exact: 0, date_level: 0, approximate: 0, recalled: 0, inferred: 0 },
      recalledOrInferredShare: null,
      totalAppliedCount: 0,
    },
  };
}

function emptyResult(): FunnelResult {
  return {
    query: {},
    overview: emptyOverview(),
    groups: [],
    totalProcessCount: 0,
    exclusions: { voidedApplicationCount: 0, notes: ['分母仅统计已确认创建的 Application。'] },
  };
}

function populatedResult(): FunnelResult {
  const overview = emptyOverview();
  overview.stages[0] = { stage: 'applied', count: 4, conversionFromPrevious: null, conversionFromApplied: 1 };
  overview.stages[1] = { stage: 'valid_reply', count: 2, conversionFromPrevious: 0.5, conversionFromApplied: 0.5 };
  overview.statusCounts.in_progress = 3;
  overview.statusCounts.rejected_by_recruiter = 1;
  overview.confidence.totalAppliedCount = 4;
  overview.confidence.counts.recalled = 3;
  overview.confidence.counts.exact = 1;
  overview.confidence.recalledOrInferredShare = 0.75;
  return {
    query: {},
    overview,
    groups: [],
    totalProcessCount: 4,
    exclusions: { voidedApplicationCount: 0, notes: ['分母仅统计已确认创建的 Application。'] },
  };
}

function groupedResult(): FunnelResult {
  const base = populatedResult();
  return {
    ...base,
    groups: [
      {
        key: { city: '上海', jobFamily: 'uncategorized', channel: 'boss', resumeVersionId: null, windowLabel: null },
        overview: base.overview,
      },
    ],
  };
}

beforeEach(() => {
  mocks.get.mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function mountPage() {
  const wrapper = mount(MarketFunnelPage);
  await flushPromises();
  return wrapper;
}

describe('MarketFunnelPage · 总览优先', () => {
  it('默认加载时展示全局总览，不请求分组', async () => {
    mocks.get.mockResolvedValue(emptyResult());
    const wrapper = await mountPage();
    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'none' }));
    expect(wrapper.text()).toContain('已投递');
    wrapper.unmount();
  });

  it('零分母时转化率显示为 —，不显示 NaN 或 Infinity', async () => {
    mocks.get.mockResolvedValue(emptyResult());
    const wrapper = await mountPage();
    expect(wrapper.text()).not.toContain('NaN');
    expect(wrapper.text()).not.toContain('Infinity');
    expect(wrapper.text()).toContain('—');
    wrapper.unmount();
  });

  it('展示两套转化率：相对上一阶段与相对已投递', async () => {
    mocks.get.mockResolvedValue(populatedResult());
    const wrapper = await mountPage();
    const text = wrapper.text();
    expect(text).toContain('相对上一阶段');
    expect(text).toContain('相对已投递');
    expect(text).toContain('起点');
  });

  it('展示可信度总览与高占比警告', async () => {
    mocks.get.mockResolvedValue(populatedResult());
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('数据可信度总览');
    expect(wrapper.text()).toContain('只适合建立求职基线');
    wrapper.unmount();
  });

  it('展示终态分布，不再全部计为进行中', async () => {
    mocks.get.mockResolvedValue(populatedResult());
    const wrapper = await mountPage();
    const text = wrapper.text();
    expect(text).toContain('招聘方拒绝');
    expect(text).toContain('沉默 / 停滞');
    wrapper.unmount();
  });

  it('分组数据非空时组件仍能正常渲染总览区域', async () => {
    mocks.get.mockResolvedValue(groupedResult());
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('已投递');
    wrapper.unmount();
  });
});
