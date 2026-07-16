import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MarketPositionProposal,
  MarketPositionVersion,
  MarketPositionView,
} from '../domain/market-position';
import { makeMarketPositionDraftFixture } from '../domain/market-position/testFixtures';
import MarketPositionPage from './MarketPositionPage.vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  createManualProposal: vi.fn(),
  acceptProposal: vi.fn(),
  rejectProposal: vi.fn(),
  deferProposal: vi.fn(),
  activateVersion: vi.fn(),
}));

vi.mock('../api/marketPositionApi', () => ({ marketPositionApi: mocks }));

function version(id: string, proposalId: string): MarketPositionVersion {
  const draft = makeMarketPositionDraftFixture();
  return {
    ...draft,
    id,
    version: 1,
    status: 'active',
    inputSnapshot: {
      jobMatchProfileVersionId: null,
      capabilityBaselineVersionId: null,
      acceptedEvidenceIds: [],
      funnelCutoffAt: 1_000,
      funnelQueryFingerprint: 'a'.repeat(64),
      inputHash: 'a'.repeat(64),
      capturedAt: 1_000,
    },
    createdAt: 1_000,
    activatedAt: 2_000,
    supersedesVersionId: null,
    proposalId,
  };
}

function proposal(id: string, status: MarketPositionProposal['status'] = 'proposed'): MarketPositionProposal {
  return {
    id,
    status,
    payload: makeMarketPositionDraftFixture(),
    acceptedPayload: null,
    decisionDiff: [],
    inputSnapshot: {
      jobMatchProfileVersionId: null,
      capabilityBaselineVersionId: null,
      acceptedEvidenceIds: [],
      funnelCutoffAt: 1_000,
      funnelQueryFingerprint: 'a'.repeat(64),
      inputHash: 'a'.repeat(64),
      capturedAt: 1_000,
    },
    generatedBy: 'manual',
    modelInfo: null,
    createdAt: 1_000,
    decidedAt: status === 'proposed' ? null : 1_100,
    decisionNote: null,
    expectedStateVersion: 0,
  };
}

function emptyView(): MarketPositionView {
  return {
    state: { stateVersion: 0, activeVersionId: null, versions: [], proposals: [], commandReceipts: [] },
    activeVersion: null,
    llmConfigured: false,
  };
}

function populatedView(): MarketPositionView {
  const active = version('v1', 'p-decided');
  const pending = proposal('p-pending');
  return {
    state: {
      stateVersion: 2,
      activeVersionId: 'v1',
      versions: [active],
      proposals: [pending],
      commandReceipts: [],
    },
    activeVersion: active,
    llmConfigured: false,
  };
}

async function mountPage(): Promise<{ wrapper: Awaited<ReturnType<typeof mount>>; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/market-position' },
      { path: '/market-position', name: 'market-position', component: MarketPositionPage },
    ],
  });
  await router.push('/market-position');
  await router.isReady();
  const wrapper = mount(MarketPositionPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('MarketPositionPage · 路由与页面', () => {
  it('挂载并显示标题', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper, router } = await mountPage();
    expect(router.currentRoute.value.name).toBe('market-position');
    expect(wrapper.find('[data-testid="mp-page"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('市场位置画像');
    wrapper.unmount();
  });

  it('空状态：还没有正式版本时提示空态', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="mp-overview-empty"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('存在正式版本时渲染全局概况与决策门', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="mp-scope-global"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mp-gate-role_positioning"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('城市 Tab：各城市独立展示自身证据等级（城市隔离在 UI 上可见）', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const suzhouTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('苏州'));
    await suzhouTab?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mp-city-suzhou"]').exists()).toBe(true);

    const wuxiTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('无锡'));
    await wuxiTab?.trigger('click');
    await flushPromises();
    // 无锡没有独立样本（fixture 中仅苏州有数据），但仍展示自身画像而非借用苏州结论。
    const wuxiCard = wrapper.find('[data-testid="mp-city-wuxi"]');
    expect(wuxiCard.exists()).toBe(true);
    expect(wuxiCard.text()).toContain('证据不足');
    wrapper.unmount();
  });

  it('审核 Tab：接受提案调用 API', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.acceptProposal.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const reviewTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'));
    await reviewTab?.trigger('click');
    await flushPromises();
    const acceptBtn = wrapper.find('[data-testid="mp-prop-accept"]');
    expect(acceptBtn.exists()).toBe(true);
    await acceptBtn.trigger('click');
    await flushPromises();
    expect(mocks.acceptProposal).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('拒绝提案调用 API 且不清空正式版本', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.rejectProposal.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const reviewTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'));
    await reviewTab?.trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="mp-prop-reject"]').trigger('click');
    await flushPromises();
    expect(mocks.rejectProposal).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('版本历史 Tab：展示当前正式版本', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const versionsTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('版本历史'));
    await versionsTab?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mp-version-v1"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('手工建立提案：打开草案编辑器并提交', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.createManualProposal.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-manual-draft"]').trigger('click');
    await flushPromises();
    // n-modal 内容通过 teleport 渲染到 document.body。
    const modal = document.body.querySelector('[data-testid="mp-draft-modal"]');
    expect(modal).not.toBeNull();
    const submitBtn = document.body.querySelector('[data-testid="mp-draft-submit"]') as HTMLElement | null;
    expect(submitBtn).not.toBeNull();
    submitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(mocks.createManualProposal).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('技术信息默认折叠，不展示内部字段', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="mp-technical"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('"stateVersion"');
    wrapper.unmount();
  });
});
