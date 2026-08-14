import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { DailySearchPlan, DailySearchPlanVersion } from '../api/dailySearchPlanApi';
import DailySearchPlanPage from './DailySearchPlanPage.vue';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listVersions: vi.fn(),
  create: vi.fn(),
  createVersion: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  skipToday: vi.fn(),
  runNow: vi.fn(),
}));

vi.mock('../api/dailySearchPlanApi', () => ({ dailySearchPlanApi: mocks }));

function plan(overrides: Partial<DailySearchPlan> = {}): DailySearchPlan {
  return {
    id: 'p1', name: '每日前端岗位', status: 'active', activeVersionId: 'v1',
    createdAt: 0, updatedAt: 0, deletedAt: null,
    ...overrides,
  };
}

function version(overrides: Partial<DailySearchPlanVersion> = {}): DailySearchPlanVersion {
  return {
    id: 'v1', searchPlanId: 'p1', version: 1,
    cities: [{ name: '苏州', priority: 1 }],
    roleDirections: ['前端开发'], baseKeywords: ['React'], expandedKeywords: [],
    hardConstraints: [],
    sourceConfigs: [{ providerKey: 'tavily', searchDepth: 'basic', country: 'china', enabled: true }],
    schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
    scanBudget: {}, analysisBudget: {}, briefPolicy: {}, explorationPolicy: {}, notificationPolicy: {},
    latestCatchUpTime: '12:00', createdAt: 0, activatedAt: 0, supersedesVersionId: null,
    ...overrides,
  };
}

function stubListWith(rows: Array<{ plan: DailySearchPlan; activeVersion: DailySearchPlanVersion | null }>): void {
  mocks.list.mockResolvedValue({ plans: rows.map((row) => row.plan) });
  mocks.get.mockImplementation(async (id: string) => {
    const row = rows.find((entry) => entry.plan.id === id);
    if (row === undefined) throw new ApiError('Not Found', 404, { code: 'NOT_FOUND', message: 'Not Found' });
    return { plan: row.plan, activeVersion: row.activeVersion };
  });
}

async function mountPage(): Promise<VueWrapper> {
  const wrapper = mount(DailySearchPlanPage);
  await flushPromises();
  return wrapper;
}

/** 找到 data-testid 组件内的真实 input/textarea 并 setValue。 */
async function setField(wrapper: VueWrapper, testid: string, value: string): Promise<void> {
  const host = wrapper.get(`[data-testid="${testid}"]`);
  const editable = host.find('input').exists() ? host.get('input') : host.get('textarea');
  await editable.setValue(value);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('DailySearchPlanPage · 列表与状态', () => {
  it('空列表展示创建 CTA，不渲染空白表格', async () => {
    stubListWith([]);
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('还没有每日求职计划');
    expect(wrapper.find('[data-testid="empty-create"]').exists()).toBe(true);
  });

  it('正常加载 plan list，展示名称与运行状态', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('每日前端岗位');
    expect(wrapper.text()).toContain('运行中');
    expect(wrapper.text()).toContain('每天 09:00');
  });

  it('列表加载失败展示后端错误信息', async () => {
    mocks.list.mockRejectedValue(new ApiError('服务器内部错误', 500, { code: 'INTERNAL_ERROR', message: '服务器内部错误' }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="page-error"]').text()).toContain('服务器内部错误');
  });

  it('能力未启用（404）展示可理解的未启用提示', async () => {
    mocks.list.mockRejectedValue(new ApiError('Not Found', 404, { code: 'NOT_FOUND', message: 'Not Found' }));
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="capability-unavailable"]').text()).toContain('每日求职计划能力当前未启用');
    expect(wrapper.text()).not.toContain('系统崩溃');
  });

  it('deleted 计划只读，禁用 Run Now / Pause / Edit', async () => {
    stubListWith([{ plan: plan({ status: 'deleted' }), activeVersion: version() }]);
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain('已删除');
    expect(wrapper.find('[data-testid="run-now"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="pause"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="resume"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="edit"]').exists()).toBe(false);
  });
});

describe('DailySearchPlanPage · 创建', () => {
  it('创建 Plan：提交 name + 结构化 config（timezone 默认 Asia/Shanghai）', async () => {
    stubListWith([]);
    mocks.create.mockResolvedValue({ plan: plan(), version: version() });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="empty-create"]').trigger('click');
    await setField(wrapper, 'form-name', '每日前端岗位');
    await setField(wrapper, 'form-daily-at', '10:30');
    await setField(wrapper, 'form-cities', '苏州\n无锡');
    await setField(wrapper, 'form-roles', '前端开发\n全栈开发');
    await setField(wrapper, 'form-keywords', 'React\nTypeScript');
    await wrapper.find('[data-testid="form-submit"]').trigger('click');
    await flushPromises();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const input = mocks.create.mock.calls[0][0] as { name: string; schedule: { dailyAt: string; timezone: string }; cities: unknown[]; roleDirections: string[] };
    expect(input.name).toBe('每日前端岗位');
    expect(input.schedule).toEqual({ dailyAt: '10:30', timezone: 'Asia/Shanghai' });
    expect(input.cities).toEqual([{ name: '苏州', priority: 1 }, { name: '无锡', priority: 2 }]);
    expect(input.roleDirections).toEqual(['前端开发', '全栈开发']);
  });

  it('时区为只读 Asia/Shanghai（中国标准时间），不暴露全球时区选择器', async () => {
    stubListWith([]);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="empty-create"]').trigger('click');
    const timezone = wrapper.get('[data-testid="form-timezone"]').get('input');
    expect((timezone.element as HTMLInputElement).value).toContain('Asia/Shanghai');
    expect((timezone.element as HTMLInputElement).value).toContain('中国标准时间');
  });

  it('invalid form（空名称 / 非法 HH:mm）阻止提交', async () => {
    stubListWith([]);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="empty-create"]').trigger('click');

    await wrapper.find('[data-testid="form-submit"]').trigger('click');
    await flushPromises();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="form-error"]').text()).toContain('计划名称不能为空');

    await setField(wrapper, 'form-name', '合法名称');
    await setField(wrapper, 'form-daily-at', '25:99');
    await wrapper.find('[data-testid="form-submit"]').trigger('click');
    await flushPromises();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="form-error"]').text()).toContain('HH:mm');
  });
});

describe('DailySearchPlanPage · 编辑新版本', () => {
  it('编辑配置创建新 Version，而非原地修改旧 Version', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    mocks.createVersion.mockResolvedValue({ version: version({ version: 2 }) });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="edit"]').trigger('click');
    expect(wrapper.text()).toContain('不会原地修改历史版本');

    await setField(wrapper, 'form-roles', '前端开发\n后端开发');
    await wrapper.find('[data-testid="form-submit"]').trigger('click');
    await flushPromises();

    expect(mocks.createVersion).toHaveBeenCalledWith('p1', expect.objectContaining({ roleDirections: ['前端开发', '后端开发'] }));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('DailySearchPlanPage · 控制操作', () => {
  it('Pause 调用后端并刷新状态为已暂停', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    mocks.pause.mockResolvedValue({ plan: plan({ status: 'paused' }) });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="pause"]').trigger('click');
    await flushPromises();

    expect(mocks.pause).toHaveBeenCalledWith('p1');
    expect(wrapper.text()).toContain('已暂停');
  });

  it('Resume 调用后端并刷新状态为运行中', async () => {
    stubListWith([{ plan: plan({ status: 'paused' }), activeVersion: version() }]);
    mocks.resume.mockResolvedValue({ plan: plan({ status: 'active' }) });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="resume"]').trigger('click');
    await flushPromises();

    expect(mocks.resume).toHaveBeenCalledWith('p1');
    expect(wrapper.text()).toContain('运行中');
  });

  it('Run Now 展示 SourceRun id 与状态', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    mocks.runNow.mockResolvedValue({ sourceRunId: 'sr_123', status: 'SUCCEEDED', briefId: null });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="run-now"]').trigger('click');
    await flushPromises();

    expect(mocks.runNow).toHaveBeenCalledWith('p1');
    expect(wrapper.find('[data-testid="page-notice"]').text()).toContain('sr_123');
    expect(wrapper.find('[data-testid="page-notice"]').text()).toContain('SUCCEEDED');
  });

  it('Run Now loading 期间防重复点击', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    let resolveRunNow!: (value: unknown) => void;
    mocks.runNow.mockImplementation(() => new Promise((resolve) => { resolveRunNow = resolve; }));
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="run-now"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="run-now"]').trigger('click');
    await flushPromises();

    expect(mocks.runNow).toHaveBeenCalledTimes(1);
    resolveRunNow({ sourceRunId: 'sr_123', status: 'SUCCEEDED', briefId: null });
    await flushPromises();
  });

  it('Run Now 后端并发冲突（409）展示冲突提示', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    mocks.runNow.mockRejectedValue(new ApiError('该计划已有进行中的运行', 409, { code: 'RUN_IN_PROGRESS', message: '该计划已有进行中的运行' }));
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="run-now"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="page-error"]').text()).toContain('该计划已有进行中的运行');
  });

  it('Skip Today 需要轻量确认，确认后展示跳过日期，且 Run Now 仍可用', async () => {
    stubListWith([{ plan: plan(), activeVersion: version() }]);
    mocks.skipToday.mockResolvedValue({ skipped: { searchPlanVersionId: 'v1', scheduledDay: '2026-08-14' } });
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="skip-today"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="skip-confirm"]').exists()).toBe(true);
    expect(mocks.skipToday).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="confirm-skip"]').trigger('click');
    await flushPromises();
    expect(mocks.skipToday).toHaveBeenCalledWith('p1');
    expect(wrapper.find('[data-testid="page-notice"]').text()).toContain('2026-08-14');

    // 跳过今天后 Run Now 仍可用（不被禁用）。
    expect(wrapper.find('[data-testid="run-now"]').exists()).toBe(true);
  });
});
