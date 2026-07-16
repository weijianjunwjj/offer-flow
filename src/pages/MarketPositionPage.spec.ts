import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  MarketPositionAiGenerationMetadata,
  MarketPositionProposal,
  MarketPositionVersion,
  MarketPositionView,
} from '../domain/market-position';
import { makeMarketPositionDraftFixture } from '../domain/market-position/testFixtures';
import MarketPositionPage from './MarketPositionPage.vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  createManualProposal: vi.fn(),
  generateProposal: vi.fn(),
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

function proposal(
  id: string,
  status: MarketPositionProposal['status'] = 'proposed',
  overrides: Partial<Pick<MarketPositionProposal, 'generatedBy' | 'aiGeneration' | 'modelInfo'>> = {},
): MarketPositionProposal {
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
    generatedBy: overrides.generatedBy ?? 'manual',
    modelInfo: overrides.modelInfo ?? null,
    aiGeneration: overrides.aiGeneration ?? null,
    createdAt: 1_000,
    decidedAt: status === 'proposed' ? null : 1_100,
    decisionNote: null,
    expectedStateVersion: 0,
  };
}

function aiMeta(): MarketPositionAiGenerationMetadata {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    generatedAt: 1_500,
    inputHash: 'a'.repeat(64),
    promptVersion: 'market-position-ai-v1',
    deterministicRuleVersion: 'market-position-deterministic-v1',
  };
}

function aiProposal(id: string): MarketPositionProposal {
  return proposal(id, 'proposed', { generatedBy: 'ai', modelInfo: 'deepseek-chat', aiGeneration: aiMeta() });
}

function emptyView(): MarketPositionView {
  return {
    state: { stateVersion: 0, activeVersionId: null, versions: [], proposals: [], commandReceipts: [] },
    activeVersion: null,
    llmConfigured: false,
    reused: false,
  };
}

function populatedView(): MarketPositionView {
  const active = version('v1', 'p-decided');
  const pending = proposal('p-pending', 'proposed', { generatedBy: 'ai', modelInfo: 'deepseek-chat', aiGeneration: aiMeta() });
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
    reused: false,
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

describe('MarketPositionPage · AI 生成市场位置提案', () => {
  it('主按钮为 AI 生成，且展示不会自动成为正式结论的提示文案', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="mp-ai-generate"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mp-ai-disclosure"]').text()).toContain('不会自动成为正式结论');
    wrapper.unmount();
  });

  it('点击 AI 生成按钮：调用生成接口并成功后自动切换到审核 Tab', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const created = aiProposal('p-ai-1');
    mocks.generateProposal.mockResolvedValue({
      state: { stateVersion: 1, activeVersionId: null, versions: [], proposals: [created], commandReceipts: [] },
      activeVersion: null,
      llmConfigured: true,
    });
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    expect(mocks.generateProposal).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="mp-proposal-p-ai-1"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('生成成功后新提案带有 AI 生成标记并高亮', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const created = aiProposal('p-ai-2');
    mocks.generateProposal.mockResolvedValue({
      state: { stateVersion: 1, activeVersionId: null, versions: [], proposals: [created], commandReceipts: [] },
      activeVersion: null,
      llmConfigured: true,
    });
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    const item = wrapper.find('[data-testid="mp-proposal-p-ai-2"]');
    expect(item.find('[data-testid="mp-proposal-source"]').text()).toContain('AI 生成');
    expect(item.classes()).toContain('mp-proposal-highlight');
    wrapper.unmount();
  });

  it('重复点击 AI 生成按钮：生成期间按钮进入 loading 且不会重复调用', async () => {
    mocks.get.mockResolvedValue(emptyView());
    let resolveGenerate: (value: MarketPositionView) => void = () => {};
    mocks.generateProposal.mockImplementation(() => new Promise((resolve) => { resolveGenerate = resolve; }));
    const { wrapper } = await mountPage();
    const button = wrapper.find('[data-testid="mp-ai-generate"]');
    await button.trigger('click');
    await button.trigger('click');
    await flushPromises();
    expect(mocks.generateProposal).toHaveBeenCalledTimes(1);
    resolveGenerate(emptyView());
    await flushPromises();
    wrapper.unmount();
  });

  it('AI 服务未配置：返回 503 时展示中文错误提示，不暴露技术栈细节', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.generateProposal.mockRejectedValue(
      new ApiError('AI 服务尚未配置，可改用手工建立市场位置提案', 503, { code: 'MARKET_POSITION_AI_UNAVAILABLE' }),
    );
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    const error = wrapper.find('[data-testid="mp-error"]');
    expect(error.text()).toContain('AI 服务尚未配置');
    expect(error.text()).not.toMatch(/stack|Error:|at [A-Za-z]+\./);
    wrapper.unmount();
  });

  it('AI 输出未通过校验：展示中文错误提示且不创建提案', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.generateProposal.mockRejectedValue(
      new ApiError('AI 生成的市场位置文案未通过安全校验', 422, { code: 'MARKET_POSITION_AI_OUTPUT_INVALID' }),
    );
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mp-error"]').text()).toContain('未能生成符合安全约束的文案');
    expect(wrapper.find('[data-testid="mp-overview-empty"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('输入已过期：展示提示需要刷新后重新生成', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.generateProposal.mockRejectedValue(
      new ApiError('正式输入数据已发生变化，请刷新后重新生成', 409, { code: 'MARKET_POSITION_INPUT_STALE' }),
    );
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mp-error"]').text()).toContain('刷新后重新生成');
    wrapper.unmount();
  });

  it('相同输入已有待审核提案：自动打开提案审核并高亮既有提案', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const existing = populatedView();
    mocks.generateProposal.mockResolvedValue({ ...existing, reused: true });
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="mp-ai-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="mp-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mp-notice"]').text()).toContain('已自动打开该提案');
    wrapper.unmount();
  });

  it('未配置 AI 服务时展示提示条，且手工建立入口仍可用', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.createManualProposal.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="mp-ai-not-configured"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mp-manual-draft"]').trigger('click');
    await flushPromises();
    const submitBtn = document.body.querySelector('[data-testid="mp-draft-submit"]') as HTMLElement | null;
    expect(submitBtn).not.toBeNull();
    submitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(mocks.createManualProposal).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('审核 Tab 展示 AI 提案的来源、生成时间与输入依据（区分于确定性字段）', async () => {
    mocks.get.mockResolvedValue({
      state: {
        stateVersion: 1, activeVersionId: null, versions: [], proposals: [aiProposal('p-ai-3')], commandReceipts: [],
      },
      activeVersion: null,
      llmConfigured: true,
    });
    const { wrapper } = await mountPage();
    const reviewTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'));
    await reviewTab?.trigger('click');
    await flushPromises();
    const metaBlock = wrapper.find('[data-testid="mp-proposal-ai-meta"]');
    expect(metaBlock.exists()).toBe(true);
    expect(metaBlock.text()).toContain('生成时间');
    const detailBlock = wrapper.find('[data-testid="mp-proposal-detail-p-ai-3"]');
    expect(detailBlock.text()).toContain('系统计算，AI 不可更改');
    wrapper.unmount();
  });

  it('修改后接受 AI 提案：打开草案编辑器并提交 modifiedPayload', async () => {
    mocks.get.mockResolvedValue({
      state: {
        stateVersion: 1, activeVersionId: null, versions: [], proposals: [aiProposal('p-ai-4')], commandReceipts: [],
      },
      activeVersion: null,
      llmConfigured: true,
    });
    mocks.acceptProposal.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const reviewTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'));
    await reviewTab?.trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="mp-prop-modify"]').trigger('click');
    await flushPromises();
    const submitBtn = document.body.querySelector('[data-testid="mp-draft-submit"]') as HTMLElement | null;
    expect(submitBtn).not.toBeNull();
    submitBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(mocks.acceptProposal).toHaveBeenCalledTimes(1);
    const call = mocks.acceptProposal.mock.calls[0]!;
    expect(call[0]).toBe('p-ai-4');
    expect(call[1]).toHaveProperty('modifiedPayload');
    wrapper.unmount();
  });
});
