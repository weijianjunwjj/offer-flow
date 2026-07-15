import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CandidateEvidence,
  CapabilityBaselineVersion,
  CapabilityBaselineView,
} from '../domain/capability-baseline';
import {
  makeCandidateEvidenceContentFixture,
  makeCapabilityBaselineDraftFixture,
} from '../domain/capability-baseline/testFixtures';
import CapabilityBaselinePage from './CapabilityBaselinePage.vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  createManualEvidence: vi.fn(),
  generateEvidence: vi.fn(),
  acceptEvidence: vi.fn(),
  rejectEvidence: vi.fn(),
  deferEvidence: vi.fn(),
  createManualBaselineProposal: vi.fn(),
  generateBaselineProposal: vi.fn(),
  acceptBaselineProposal: vi.fn(),
  rejectBaselineProposal: vi.fn(),
  deferBaselineProposal: vi.fn(),
  activateVersion: vi.fn(),
}));

vi.mock('../api/capabilityBaselineApi', () => ({ capabilityBaselineApi: mocks }));

function evidence(id: string, status: CandidateEvidence['status']): CandidateEvidence {
  return {
    ...makeCandidateEvidenceContentFixture(),
    id,
    generatedBy: 'ai',
    status,
    acceptedContent: null,
    decisionDiff: [],
    modelInfo: 'fake-model',
    inputFingerprint: 'a'.repeat(64),
    createdAt: 1_000,
    decidedAt: status === 'proposed' ? null : 1_100,
    decisionNote: null,
    expectedStateVersion: 0,
  };
}

function version(id: string): CapabilityBaselineVersion {
  return {
    ...makeCapabilityBaselineDraftFixture(['acc-1']),
    id,
    version: 1,
    status: 'active',
    sourceSnapshot: {
      inputFingerprint: 'a'.repeat(64),
      activeResumeVersionId: null,
      acceptedEvidenceCount: 1,
      jobCount: 0,
      applicationCount: 0,
      feedbackEventCount: 0,
      capturedAt: 1_000,
    },
    evidenceRefs: ['acc-1'],
    createdAt: 1_000,
    activatedAt: 2_000,
    supersedesVersionId: null,
    proposalId: 'p-1',
  };
}

function emptyView(): CapabilityBaselineView {
  return {
    state: { stateVersion: 0, activeVersionId: null, evidence: [], versions: [], proposals: [], commandReceipts: [] },
    activeVersion: null,
    llmConfigured: true,
  };
}

function populatedView(): CapabilityBaselineView {
  const active = version('v1');
  const support = { ...evidence('acc-1', 'accepted'), polarity: 'support' as const, summary: '支持证据说明。' };
  const counter = { ...evidence('acc-2', 'accepted'), polarity: 'counter' as const, sourceConfidence: 'exact' as const, summary: '反证说明。' };
  const pending = evidence('pending-1', 'proposed');
  return {
    state: {
      stateVersion: 4,
      activeVersionId: 'v1',
      evidence: [support, counter, pending],
      versions: [active],
      proposals: [],
      commandReceipts: [],
    },
    activeVersion: active,
    llmConfigured: true,
  };
}

async function mountPage(): Promise<{ wrapper: Awaited<ReturnType<typeof mount>>; router: Router }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/capability-baseline' },
      { path: '/capability-baseline', name: 'capability-baseline', component: CapabilityBaselinePage },
    ],
  });
  await router.push('/capability-baseline');
  await router.isReady();
  const wrapper = mount(CapabilityBaselinePage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('CapabilityBaselinePage · 路由与页面', () => {
  it('一级路由挂载并显示标题', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper, router } = await mountPage();
    expect(router.currentRoute.value.name).toBe('capability-baseline');
    expect(wrapper.find('[data-testid="cb-page"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('能力基线');
    wrapper.unmount();
  });

  it('空状态：显示尚未建立正式能力基线', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="cb-baseline-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('尚未建立正式能力基线');
    wrapper.unmount();
  });

  it('技术信息默认折叠，不展开原始 JSON', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="cb-technical"]').exists()).toBe(true);
    // 折叠区默认不渲染内部 stateVersion 原始 JSON
    expect(wrapper.text()).not.toContain('"stateVersion"');
    wrapper.unmount();
  });

  it('默认画面不暴露内部字段名与原始枚举', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const text = wrapper.text();
    expect(text).not.toContain('conclusionStatus');
    expect(text).not.toContain('expectedStateVersion');
    expect(text).not.toContain('inputFingerprint');
    wrapper.unmount();
  });

  it('存在正式基线时渲染能力维度与结论状态中文标签', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="cb-dim-vue_typescript_engineering"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Vue / TypeScript 工程能力');
    wrapper.unmount();
  });

  it('候选证据审核：点击接受调用 API', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.acceptEvidence.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    // 切到审核 Tab
    const reviewTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('候选证据审核'));
    await reviewTab?.trigger('click');
    await flushPromises();
    const acceptBtn = wrapper.find('[data-testid="cb-ev-accept"]');
    expect(acceptBtn.exists()).toBe(true);
    await acceptBtn.trigger('click');
    await flushPromises();
    expect(mocks.acceptEvidence).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('证据库同时展示支持证据与反证（反证不被隐藏）', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const libraryTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('证据库'));
    await libraryTab?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="cb-library-acc-1"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="cb-library-acc-2"]').exists()).toBe(true);
    const libraryText = wrapper.find('[data-testid="cb-library"]').text();
    expect(libraryText).toContain('支持');
    expect(libraryText).toContain('反证');
    wrapper.unmount();
  });

  it('版本历史展示当前正式版本', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const versionsTab = wrapper.findAll('.n-tabs-tab').find((t) => t.text().includes('版本历史'));
    await versionsTab?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="cb-version-v1"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('未配置 LLM 时禁用 AI 入口并提示', async () => {
    mocks.get.mockResolvedValue({ ...emptyView(), llmConfigured: false });
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="cb-llm-hint"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
