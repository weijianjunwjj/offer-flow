import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  buildDeterministicStrategyDraft,
  type StrategyProposal,
  type StrategyView,
  type StrategyVersion,
} from '../domain/strategy-window';
import { makeStrategyWindow } from '../domain/strategy-window/testFixtures';
import StrategyWindowPage from './StrategyWindowPage.vue';
import { ApiNetworkError } from '../api/client';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), createManualProposal: vi.fn(), generateProposal: vi.fn(),
  acceptProposal: vi.fn(), rejectProposal: vi.fn(), deferProposal: vi.fn(), activateVersion: vi.fn(),
  getInputSnapshot: vi.fn(),
}));
vi.mock('../api/strategyWindowApi', () => ({ strategyWindowApi: mocks }));

const featuresMock = vi.hoisted(() => ({ features: { g5SandboxEnabled: false } }));
vi.mock('../config/features', () => featuresMock);

const window = makeStrategyWindow('insufficient');
const draft = buildDeterministicStrategyDraft(window, (() => { let n = 0; return { createId: () => `sa-${++n}` }; })());

function emptyView(overrides: Partial<StrategyView> = {}): StrategyView {
  return {
    state: { stateVersion: 0, activeVersionId: null, versions: [], proposals: [], commandReceipts: [] },
    activeVersion: null,
    currentWindow: window,
    inputReady: true,
    llmConfigured: true,
    reused: false,
    ...overrides,
  };
}

function aiProposal(id = 'p-ai-1'): StrategyProposal {
  return {
    id, status: 'proposed', window, payload: draft, acceptedPayload: null, decisionDiff: [],
    inputSnapshot: {
      jobMatchProfileVersionId: null, capabilityBaselineVersionId: null, marketPositionVersionId: 'mpv-1',
      acceptedEvidenceIds: [], funnelCutoffAt: 1, funnelQueryFingerprint: 'b'.repeat(64),
      evidenceLevel: 'insufficient', decisionGateStatuses: window.decisionGateSnapshot,
      allowedClaims: [], blockedClaims: [], inputHash: 'a'.repeat(64), capturedAt: 1,
    },
    generatedBy: 'ai', modelInfo: 'fake-model',
    aiGeneration: { provider: 'deepseek', model: 'fake-model', generatedAt: 1, inputHash: 'a'.repeat(64), promptVersion: 'v1', deterministicRuleVersion: 'v1' },
    createdAt: 1, decidedAt: null, decisionNote: null, expectedStateVersion: 0, stale: false,
  };
}

function version(id = 'v-1'): StrategyVersion {
  return {
    id, version: 1, status: 'active', window, payload: draft,
    inputSnapshot: aiProposal().inputSnapshot, generationMode: 'ai', decisionDiff: [],
    createdAt: 1, activatedAt: 1, supersedesVersionId: null, proposalId: 'p-ai-1',
  };
}

function proposalView(): StrategyView {
  return emptyView({ state: { stateVersion: 1, activeVersionId: null, versions: [], proposals: [aiProposal()], commandReceipts: [] } });
}

function activeView(): StrategyView {
  const v = version();
  return emptyView({
    state: { stateVersion: 2, activeVersionId: v.id, versions: [v], proposals: [], commandReceipts: [] },
    activeVersion: v,
  });
}

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/strategy-window', name: 'strategy-window', component: StrategyWindowPage }],
  });
  router.push('/strategy-window');
  await router.isReady();
  const wrapper = mount(StrategyWindowPage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper };
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  featuresMock.features.g5SandboxEnabled = false;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('StrategyWindowPage', () => {
  it('AI 生成为主入口、手工入口保留、免责说明可见', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="sw-ai-generate"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-manual-draft"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-ai-disclosure"]').text()).toContain('不会自动执行');
    wrapper.unmount();
  });

  it('展示当前窗口与复盘条件，并使用中文枚举映射', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    const windowCard = wrapper.find('[data-testid="sw-current-window"]');
    expect(windowCard.exists()).toBe(true);
    expect(windowCard.text()).toContain('证据收集窗口');
    expect(windowCard.text()).toContain('14');
    wrapper.unmount();
  });

  it('三类边界清晰展示，禁止动作不出现在“现在可以做”', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('三类边界'))?.trigger('click');
    await flushPromises();
    const canDo = wrapper.find('[data-testid="sw-can-do"]');
    const cannotDo = wrapper.find('[data-testid="sw-cannot-do"]');
    expect(canDo.exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-observe-only"]').exists()).toBe(true);
    expect(cannotDo.exists()).toBe(true);
    // 证据收集窗口禁止“薪资区间试探”，不得出现在“现在可以做”。
    expect(canDo.text()).not.toContain('薪资区间试探');
    expect(cannotDo.text()).toContain('不得直接降薪');
    expect(cannotDo.text()).toContain('不得直接搬迁');
    wrapper.unmount();
  });

  it('输入未就绪时提示并禁用 AI 生成', async () => {
    mocks.get.mockResolvedValue(emptyView({ currentWindow: null, inputReady: false }));
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="sw-input-not-ready"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-ai-generate"]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('点击 AI 生成调用 API 并切换到提案审核', async () => {
    mocks.get.mockResolvedValue(emptyView());
    mocks.generateProposal.mockResolvedValue(proposalView());
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="sw-ai-generate"]').trigger('click');
    await flushPromises();
    expect(mocks.generateProposal).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="sw-review"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('重复点击 AI 生成不会重复调用', async () => {
    mocks.get.mockResolvedValue(emptyView());
    let resolveGen: (v: StrategyView) => void = () => {};
    mocks.generateProposal.mockImplementation(() => new Promise((resolve) => { resolveGen = resolve; }));
    const { wrapper } = await mountPage();
    const button = wrapper.find('[data-testid="sw-ai-generate"]');
    await button.trigger('click');
    await button.trigger('click');
    await flushPromises();
    expect(mocks.generateProposal).toHaveBeenCalledTimes(1);
    resolveGen(proposalView());
    await flushPromises();
    wrapper.unmount();
  });

  it('提案审核区展示来源标签与操作按钮', async () => {
    mocks.get.mockResolvedValue(proposalView());
    const { wrapper } = await mountPage();
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'))?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="sw-proposal-p-ai-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-proposal-source"]').text()).toContain('AI 生成');
    expect(wrapper.find('[data-testid="sw-prop-accept"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-prop-modify"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-prop-reject"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-prop-defer"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('接受提案调用 acceptProposal', async () => {
    mocks.get.mockResolvedValue(proposalView());
    mocks.acceptProposal.mockResolvedValue(activeView());
    const { wrapper } = await mountPage();
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('提案审核'))?.trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="sw-prop-accept"]').trigger('click');
    await flushPromises();
    expect(mocks.acceptProposal).toHaveBeenCalledTimes(1);
    expect(mocks.acceptProposal.mock.calls[0][0]).toBe('p-ai-1');
    wrapper.unmount();
  });

  it('展示策略总览、行动清单与版本历史', async () => {
    mocks.get.mockResolvedValue(activeView());
    const { wrapper } = await mountPage();
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('策略总览'))?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="sw-overview"]').exists()).toBe(true);
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('行动清单'))?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="sw-actions"]').exists()).toBe(true);
    await wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('版本历史'))?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="sw-versions"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="sw-version-v-1"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('默认画面不暴露 inputHash 等内部字段原文', async () => {
    mocks.get.mockResolvedValue(activeView());
    const { wrapper } = await mountPage();
    expect(wrapper.text()).not.toContain('inputHash');
    expect(wrapper.text()).not.toContain('a'.repeat(64));
    expect(wrapper.text()).not.toContain('requestHash');
    wrapper.unmount();
  });

  it('G5 沙箱环境下后端连接失败给出重启提示', async () => {
    featuresMock.features.g5SandboxEnabled = true;
    mocks.get.mockResolvedValue(emptyView());
    mocks.generateProposal.mockRejectedValue(new ApiNetworkError(new TypeError('Failed to fetch')));
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="sw-ai-generate"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="sw-error"]').text()).toContain('G5 隔离环境后端未启动或已退出，请重新启动 dev:g5-sandbox。');
    wrapper.unmount();
  });
});
