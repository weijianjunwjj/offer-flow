import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeVersionListResponse, ResumeVersionRecord } from '../domain/job-memory';
import type { JobSeekerProfile } from '../storage';
import { ResumeVersionApiError } from '../api/resumeVersionsApi';
import { hashResumeContentSnapshot } from './resumeVersionsModel';
import ResumeVersionsPage from './ResumeVersionsPage.vue';

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  updateMetadata: vi.fn(),
  activate: vi.fn(),
  archive: vi.fn(),
  profileGet: vi.fn(),
}));

vi.mock('../api/resumeVersionsApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/resumeVersionsApi')>();
  return {
    ...original,
    resumeVersionsApi: {
      list: apiMocks.list,
      create: apiMocks.create,
      updateMetadata: apiMocks.updateMetadata,
      activate: apiMocks.activate,
      archive: apiMocks.archive,
    },
  };
});

vi.mock('../api/profileApi', () => ({
  profileApi: { get: apiMocks.profileGet },
}));

const profile: JobSeekerProfile = {
  resumeText: 'Vue 3 + TypeScript',
  projectExperience: 'OfferFlow 项目',
  targetCity: '苏州',
  targetRole: '高级前端',
  expectedSalary: '20-30K',
  acceptOutsourcing: false,
  acceptOvertime: false,
  jobSearchFocus: 'growth',
  weaknessNote: '',
};

function version(id: string, overrides: Partial<ResumeVersionRecord> = {}): ResumeVersionRecord {
  return {
    id,
    name: `简历 ${id}`,
    source: 'profile_snapshot',
    contentHash: `${id}0123456789abcdef`,
    summary: `摘要 ${id}`,
    contentSnapshot: { resumeText: `正文 ${id}`, projectExperience: `项目 ${id}` },
    createdAt: 100,
    archivedAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function listResponse(
  resumeVersions: ResumeVersionRecord[],
  activeResumeVersionId: string | null = null,
): ResumeVersionListResponse {
  return { resumeVersions, activeResumeVersionId };
}

async function mountPage(): Promise<{ wrapper: VueWrapper; router: Router }> {
  const OtherPage = defineComponent({ render: () => h('p', 'other') });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: ResumeVersionsPage },
      { path: '/other', component: OtherPage },
    ],
  });
  await router.push('/');
  await router.isReady();
  const Host = defineComponent({ render: () => h(RouterView) });
  const wrapper = mount(Host, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

function button(wrapper: VueWrapper, text: string) {
  const match = wrapper.findAll('button').find((candidate) => candidate.text().includes(text));
  if (match === undefined) throw new Error(`找不到按钮：${text}`);
  return match;
}

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResumeVersionsPage', () => {
  it('稳定展示状态和短 hash，确认后从真实 Profile 快照创建且不自动激活', async () => {
    const active = version('active', { createdAt: 1 });
    const available = version('available', { createdAt: 200 });
    const archived = version('archived', { createdAt: 300, archivedAt: 400 });
    const created = version('created', {
      name: '我的正式快照',
      contentSnapshot: {
        resumeText: profile.resumeText,
        projectExperience: profile.projectExperience,
      },
    });
    apiMocks.list
      .mockResolvedValueOnce(listResponse([archived, available, active], active.id))
      .mockResolvedValueOnce(listResponse([archived, available, active, created], active.id));
    apiMocks.profileGet.mockResolvedValue(profile);
    apiMocks.create.mockResolvedValue(created);
    const { wrapper } = await mountPage();

    expect(wrapper.findAll('.version-card').map((card) => card.attributes('data-version-id')))
      .toEqual(['active', 'available', 'archived']);
    expect(wrapper.text()).toContain('当前激活');
    expect(wrapper.text()).toContain('可用');
    expect(wrapper.text()).toContain('已归档');
    expect(wrapper.text()).not.toContain('active0123456789abcdef');
    expect(wrapper.text()).not.toContain('profile_snapshot');
    expect(wrapper.text()).not.toContain('contentHash');
    expect(wrapper.text()).not.toContain('rowVersion');
    for (const raw of [
      'stage', 'outcome', 'communicationStatus', 'followUpCount', 'nextAllowedFollowUpAt',
      'lastMeaningfulEventAt', 'projectionStatus', 'direct_employer', 'not_contacted',
      'application_created', 'sourceConfidence', 'evidenceLevel', 'timePrecision',
    ]) {
      expect(wrapper.text()).not.toContain(raw);
    }

    await button(wrapper, '从当前个人档案创建版本').trigger('click');
    expect(wrapper.get('.snapshot-preview').text()).toContain(profile.resumeText);
    expect(wrapper.get('.snapshot-preview').text()).toContain(profile.projectExperience);
    await wrapper.get('input[type="text"]').setValue('我的正式快照');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await button(wrapper, '确认创建快照').trigger('click');
    expect(apiMocks.create).not.toHaveBeenCalled();

    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await button(wrapper, '确认创建快照').trigger('click');
    await flushPromises();
    expect(apiMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: '我的正式快照',
      source: 'profile_snapshot',
      contentSnapshot: {
        resumeText: profile.resumeText,
        projectExperience: profile.projectExperience,
      },
    }));
    expect(apiMocks.create.mock.calls[0]?.[0].idempotencyKey).toMatch(/^resume-version-/);
    expect(apiMocks.activate).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('不会自动激活');
    wrapper.unmount();
  });

  it.each([
    ['无 Profile', null],
    ['Profile 内容为空', { ...profile, resumeText: ' ', projectExperience: '' }],
  ])('%s 时禁止创建并给出明确状态', async (_label, profileValue) => {
    apiMocks.list.mockResolvedValue(listResponse([]));
    apiMocks.profileGet.mockResolvedValue(profileValue);
    const { wrapper } = await mountPage();
    expect(button(wrapper, '从当前个人档案创建版本').attributes()).toHaveProperty('disabled');
    expect(wrapper.text()).toMatch(/尚未保存个人档案|不能创建空白版本/);
    expect(apiMocks.create).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('VERSION_CONFLICT 保留编辑草稿，并由用户触发重新加载', async () => {
    const original = version('resume-1', { name: '旧名称', rowVersion: 1 });
    const latest = version('resume-1', { name: '他处名称', rowVersion: 2 });
    apiMocks.list
      .mockResolvedValueOnce(listResponse([original]))
      .mockResolvedValueOnce(listResponse([latest]));
    apiMocks.profileGet.mockResolvedValue(profile);
    apiMocks.updateMetadata.mockRejectedValue(new ResumeVersionApiError(
      'VERSION_CONFLICT',
      '不要解析 message',
      409,
      undefined,
      2,
    ));
    const { wrapper } = await mountPage();
    await button(wrapper, '编辑名称与摘要').trigger('click');
    const nameInput = wrapper.get('input[type="text"]');
    await nameInput.setValue('我的草稿名称');
    await button(wrapper, '确认保存元数据').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('草稿已保留');
    expect((nameInput.element as HTMLInputElement).value).toBe('我的草稿名称');
    expect(apiMocks.updateMetadata).toHaveBeenCalledWith('resume-1', {
      expectedVersion: 1,
      name: '我的草稿名称',
      summary: original.summary,
    });

    await button(wrapper, '重新加载').trigger('click');
    await flushPromises();
    expect((wrapper.get('input[type="text"]').element as HTMLInputElement).value).toBe('我的草稿名称');
    expect(wrapper.text()).toContain('草稿仍保留');
    wrapper.unmount();
  });

  it('编辑 Modal dirty 关闭需要确认，no-op 时禁止提交', async () => {
    const original = version('resume-1');
    apiMocks.list.mockResolvedValue(listResponse([original]));
    apiMocks.profileGet.mockResolvedValue(profile);
    const { wrapper } = await mountPage();
    await button(wrapper, '编辑名称与摘要').trigger('click');
    expect(button(wrapper, '确认保存元数据').attributes()).toHaveProperty('disabled');
    await wrapper.get('input[type="text"]').setValue('未保存草稿');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wrapper.get('button[aria-label="关闭编辑窗口"]').trigger('click');
    expect(wrapper.find('[aria-labelledby="edit-title"]').exists()).toBe(true);
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await wrapper.get('button[aria-label="关闭编辑窗口"]').trigger('click');
    expect(wrapper.find('[aria-labelledby="edit-title"]').exists()).toBe(false);
    expect(apiMocks.updateMetadata).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('归档 active 版本必须选择替代或明确清空，且不会发送 DELETE', async () => {
    const active = version('active');
    const replacement = version('replacement');
    const archivedActive = version('active', { archivedAt: 300, rowVersion: 2 });
    apiMocks.list.mockResolvedValue(listResponse([active, replacement], active.id));
    apiMocks.profileGet.mockResolvedValue(profile);
    apiMocks.archive.mockResolvedValue({
      resumeVersion: archivedActive,
      activeResumeVersionId: replacement.id,
    });
    const { wrapper } = await mountPage();
    const activeCard = wrapper.get('.version-card.active');
    const archiveButton = activeCard.findAll('button').find((candidate) => candidate.text() === '归档');
    if (archiveButton === undefined) throw new Error('active 版本缺少归档按钮');
    await archiveButton.trigger('click');
    expect(button(wrapper, '确认归档').attributes()).toHaveProperty('disabled');
    await wrapper.get('input[type="radio"]').trigger('change');
    await wrapper.get('select[aria-label="替代简历版本"]').setValue(replacement.id);
    expect(button(wrapper, '确认归档').attributes()).not.toHaveProperty('disabled');
    await button(wrapper, '确认归档').trigger('click');
    await flushPromises();
    expect(apiMocks.archive).toHaveBeenCalledWith(active.id, {
      expectedVersion: active.rowVersion,
      replacementResumeVersionId: replacement.id,
    });
    expect(wrapper.text()).toContain('历史记录仍保留');
    wrapper.unmount();
  });

  it('普通归档和激活在用户取消确认时不写入', async () => {
    const available = version('available');
    apiMocks.list.mockResolvedValue(listResponse([available]));
    apiMocks.profileGet.mockResolvedValue(profile);
    vi.mocked(window.confirm).mockReturnValue(false);
    const { wrapper } = await mountPage();
    await button(wrapper, '激活').trigger('click');
    await button(wrapper, '归档').trigger('click');
    expect(apiMocks.activate).not.toHaveBeenCalled();
    expect(apiMocks.archive).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('创建网络结果不明时先 reload，并通过内容 hash 识别已落库结果', async () => {
    const contentSnapshot = {
      resumeText: profile.resumeText,
      projectExperience: profile.projectExperience,
    };
    const reconciled = version('reconciled', {
      contentHash: await hashResumeContentSnapshot(contentSnapshot),
      contentSnapshot,
    });
    apiMocks.list
      .mockResolvedValueOnce(listResponse([]))
      .mockResolvedValueOnce(listResponse([reconciled]));
    apiMocks.profileGet.mockResolvedValue(profile);
    apiMocks.create.mockRejectedValue(new ResumeVersionApiError('NETWORK_ERROR', 'offline'));
    const { wrapper } = await mountPage();
    await button(wrapper, '从当前个人档案创建版本').trigger('click');
    await button(wrapper, '确认创建快照').trigger('click');
    await vi.waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    await flushPromises();
    expect(apiMocks.create).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('通过内容 hash 确认版本创建成功');
    wrapper.unmount();
  });

  it('页面销毁会 abort 读取，迟到响应不能继续写页面状态', async () => {
    let resolveList!: (value: ResumeVersionListResponse) => void;
    let capturedSignal: AbortSignal | undefined;
    apiMocks.list.mockImplementation((options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return new Promise((resolve) => { resolveList = resolve; });
    });
    apiMocks.profileGet.mockResolvedValue(profile);
    const { wrapper } = await mountPage();
    expect(capturedSignal?.aborted).toBe(false);
    wrapper.unmount();
    expect(capturedSignal?.aborted).toBe(true);
    resolveList(listResponse([version('late')]));
    await flushPromises();
    expect(apiMocks.create).not.toHaveBeenCalled();
  });

  it('写请求不随读取 signal 取消，页面销毁后迟到创建响应不再触发刷新', async () => {
    let resolveCreate!: (value: ResumeVersionRecord) => void;
    apiMocks.list.mockResolvedValue(listResponse([]));
    apiMocks.profileGet.mockResolvedValue(profile);
    apiMocks.create.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const { wrapper } = await mountPage();
    await button(wrapper, '从当前个人档案创建版本').trigger('click');
    await button(wrapper, '确认创建快照').trigger('click');
    expect(apiMocks.create).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    resolveCreate(version('late-created'));
    await flushPromises();
    expect(apiMocks.list).toHaveBeenCalledTimes(1);
  });

  it('后端 capability 关闭时显示不可用，不伪装成空列表', async () => {
    apiMocks.list.mockRejectedValue(new ResumeVersionApiError(
      'FEATURE_UNAVAILABLE',
      'route missing',
      404,
    ));
    apiMocks.profileGet.mockResolvedValue(profile);
    const { wrapper } = await mountPage();
    expect(wrapper.text()).toContain('功能未启用');
    expect(wrapper.text()).toContain('Job Memory v2 capability');
    expect(wrapper.text()).not.toContain('还没有简历版本');
    wrapper.unmount();
  });
});
