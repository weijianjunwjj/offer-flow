import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  JobMatchProfileProposal,
  JobMatchProfileVersion,
  JobMatchProfileView,
} from '../domain/job-match-profile';
import { makeJobMatchProfileDraftFixture } from '../domain/job-match-profile/testFixtures';
import JobMatchProfilePage from './JobMatchProfilePage.vue';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  generate: vi.fn(),
  manual: vi.fn(),
  accept: vi.fn(),
  reject: vi.fn(),
  defer: vi.fn(),
  activate: vi.fn(),
}));

vi.mock('../api/jobMatchProfileApi', () => ({ jobMatchProfileApi: mocks }));

function sourceSnapshot() {
  return {
    inputFingerprint: 'a'.repeat(64),
    activeResumeVersionId: null,
    jobCount: 0,
    applicationCount: 0,
    feedbackEventCount: 0,
    cityApplicationCounts: { suzhou: 0, wuxi: 0, shanghai: 0, hangzhou: 0 },
    capturedAt: 1_000,
  };
}

function version(id: string, versionNumber: number, status: 'active' | 'archived', northStar: string): JobMatchProfileVersion {
  return {
    ...makeJobMatchProfileDraftFixture(),
    northStarPositioning: northStar,
    id,
    version: versionNumber,
    status,
    sourceSnapshot: sourceSnapshot(),
    createdAt: 1_000,
    activatedAt: 2_000,
    supersedesVersionId: null,
    proposalId: `p-${id}`,
  };
}

function proposal(id: string): JobMatchProfileProposal {
  return {
    id,
    status: 'proposed',
    payload: { ...makeJobMatchProfileDraftFixture(), northStarPositioning: '待审核提案定位' },
    acceptedPayload: null,
    decisionDiff: [],
    inputFingerprint: 'b'.repeat(64),
    generatedBy: 'manual',
    modelInfo: null,
    sourceSnapshot: sourceSnapshot(),
    createdAt: 1_500,
    decidedAt: null,
    decisionNote: null,
    expectedProfileStateVersion: 1,
  };
}

function emptyView(): JobMatchProfileView {
  return {
    state: { stateVersion: 0, activeVersionId: null, versions: [], proposals: [], commandReceipts: [] },
    activeVersion: null,
    llmConfigured: true,
  };
}

function populatedView(): JobMatchProfileView {
  const active = version('v1', 1, 'active', '当前正式定位');
  const archived = version('v0', 0 + 1, 'archived', '历史定位');
  // 给归档版本一个不同的编号
  archived.version = 2;
  active.version = 3;
  const pending = proposal('prop-1');
  return {
    state: {
      stateVersion: 5,
      activeVersionId: 'v1',
      versions: [active, archived],
      proposals: [pending],
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
      { path: '/', redirect: '/job-match-profile' },
      { path: '/job-match-profile', name: 'job-match-profile', component: JobMatchProfilePage },
    ],
  });
  await router.push('/job-match-profile');
  await router.isReady();
  const wrapper = mount(JobMatchProfilePage, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.generate.mockReset();
  mocks.manual.mockReset();
  mocks.accept.mockReset();
  mocks.reject.mockReset();
  mocks.defer.mockReset();
  mocks.activate.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('JobMatchProfilePage · 路由与页面', () => {
  it('路由挂载后加载画像并显示标题', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper, router } = await mountPage();
    expect(router.currentRoute.value.name).toBe('job-match-profile');
    expect(wrapper.find('[data-testid="jmp-page"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('岗位匹配画像');
    wrapper.unmount();
  });

  it('空状态：显示尚未建立正式画像', async () => {
    mocks.get.mockResolvedValue(emptyView());
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain('尚未建立正式画像');
    expect(wrapper.find('[data-testid="jmp-empty"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('存在正式画像时渲染全局与四城市 Tab、样本不足警告', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const text = wrapper.text();
    expect(text).toContain('全局画像');
    expect(text).toContain('苏州');
    expect(text).toContain('无锡');
    expect(text).toContain('上海');
    expect(text).toContain('杭州');
    // fixture 全局置信为 exploratory，应展示样本不足/探索性守卫
    expect(wrapper.find('[data-testid="jmp-sample-guard"]').exists()).toBe(true);
    expect(text).toContain('禁止据此正式降薪');
    wrapper.unmount();
  });

  it('接受待审核提案时调用 accept API', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.accept.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="jmp-accept"]').trigger('click');
    await flushPromises();
    expect(mocks.accept).toHaveBeenCalledTimes(1);
    expect(mocks.accept.mock.calls[0]?.[0]).toBe('prop-1');
    wrapper.unmount();
  });

  it('拒绝与稍后处理分别调用对应 API', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.reject.mockResolvedValue(populatedView());
    mocks.defer.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    await wrapper.find('[data-testid="jmp-reject"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="jmp-defer"]').trigger('click');
    await flushPromises();
    expect(mocks.reject).toHaveBeenCalledTimes(1);
    expect(mocks.defer).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('版本历史可切换历史版本', async () => {
    mocks.get.mockResolvedValue(populatedView());
    mocks.activate.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="jmp-versions"]').exists()).toBe(true);
    await wrapper.find('[data-testid="jmp-activate"]').trigger('click');
    await flushPromises();
    expect(mocks.activate).toHaveBeenCalledTimes(1);
    expect(mocks.activate.mock.calls[0]?.[0]).toBe('v0');
    wrapper.unmount();
  });

  it('AI 未配置时禁用生成入口', async () => {
    mocks.get.mockResolvedValue({ ...emptyView(), llmConfigured: false });
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="jmp-llm-hint"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('技术信息默认折叠', async () => {
    mocks.get.mockResolvedValue(populatedView());
    const { wrapper } = await mountPage();
    const technical = wrapper.find('[data-testid="jmp-technical"]');
    expect(technical.exists()).toBe(true);
    expect(technical.text()).toContain('查看技术信息');
    // 折叠状态下不展示技术 JSON
    expect(wrapper.text()).not.toContain('"activeVersionId"');
    wrapper.unmount();
  });
});
