import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HistoricalBaselineDraft,
  HistoricalImportSession,
  HistoricalImportSessionBundle,
} from '../domain/history-import';
import HistoryImportPage from './HistoryImportPage.vue';

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSessionBundle: vi.fn(),
  markPreviewGenerated: vi.fn(),
  confirmSession: vi.fn(),
  discardSession: vi.fn(),
  createBaselineDraft: vi.fn(),
  updateBaselineDraft: vi.fn(),
  deleteBaselineDraft: vi.fn(),
  createEventDraft: vi.fn(),
  updateEventDraft: vi.fn(),
  deleteEventDraft: vi.fn(),
}));

vi.mock('../api/historyImportApi', () => ({ historyImportApi: mocks }));

function makeSession(overrides: Partial<HistoricalImportSession> = {}): HistoricalImportSession {
  return {
    id: 'session-1',
    status: 'draft',
    createdAt: 1_000,
    updatedAt: 1_000,
    confirmedAt: null,
    discardedAt: null,
    rowVersion: 1,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<HistoricalBaselineDraft> = {}): HistoricalBaselineDraft {
  return {
    id: 'draft-1',
    sessionId: 'session-1',
    company: 'X 公司',
    role: 'AI 应用工程师',
    city: '苏州',
    actuallyApplied: true,
    appliedAt: 2_000,
    timePrecision: 'approximate',
    channel: 'boss',
    recruitingEntityKind: 'unknown',
    recruitingEntityName: null,
    contactName: null,
    resumeVersionId: null,
    highestKnownStage: null,
    sourceConfidence: 'recalled',
    evidenceLevel: 'weak',
    notes: null,
    duplicateOfDraftId: null,
    keepAsIndependentProcess: false,
    independentProcessReason: null,
    createdJobId: null,
    createdApplicationId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    rowVersion: 1,
    ...overrides,
  };
}

function bundleWith(session: HistoricalImportSession, drafts: HistoricalBaselineDraft[] = []): HistoricalImportSessionBundle {
  return {
    session,
    drafts: drafts.map((draft) => ({ draft, events: [] })),
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listSessions.mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

async function mountPage() {
  const wrapper = mount(HistoryImportPage);
  await flushPromises();
  return wrapper;
}

describe('HistoryImportPage · 会话列表', () => {
  it('无会话时显示空状态与新建按钮', async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="hi-session-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="hi-new-session"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('创建新会话后进入向导并显示最小基线区域', async () => {
    const session = makeSession();
    mocks.createSession.mockResolvedValue(session);
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="hi-baseline-list"]').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('HistoryImportPage · 基线草稿与预览', () => {
  it('未投递草稿在预览中标注排除原因，不计入漏斗', async () => {
    const session = makeSession({ status: 'preview_generated', rowVersion: 2 });
    const draft = makeDraft({ actuallyApplied: false });
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session, [draft]));
    mocks.createSession.mockResolvedValue(makeSession());
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="hi-preview-result"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('不会创建求职流程');
    expect(wrapper.text()).toContain('不计入求职漏斗');
    wrapper.unmount();
  });

  it('弱证据/回忆数据草稿在预览中标注弱证据标签', async () => {
    const session = makeSession({ status: 'preview_generated' });
    const draft = makeDraft({ sourceConfidence: 'recalled', evidenceLevel: 'weak' });
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session, [draft]));
    mocks.createSession.mockResolvedValue(makeSession());
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('回忆 / 推断数据，弱证据');
    wrapper.unmount();
  });

  it('疑似重复草稿在预览中展示重复警告', async () => {
    const session = makeSession({ status: 'preview_generated' });
    const original = makeDraft({ id: 'draft-original', company: 'Y 公司', role: '前端工程师' });
    const duplicate = makeDraft({ id: 'draft-dup', duplicateOfDraftId: 'draft-original' });
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session, [original, duplicate]));
    mocks.createSession.mockResolvedValue(makeSession());
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('疑似与');
    wrapper.unmount();
  });

  it('确认补录后展示补录结果', async () => {
    const session = makeSession({ status: 'preview_generated' });
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session, [makeDraft()]));
    mocks.createSession.mockResolvedValue(makeSession());
    mocks.confirmSession.mockResolvedValue({
      session: { ...session, status: 'confirmed' },
      outcomes: [{ baselineDraftId: 'draft-1', kind: 'created_application', jobId: 'job-1', applicationId: 'app-1' }],
    });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="hi-confirm"]').trigger('click');
    await flushPromises();
    expect(mocks.confirmSession).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="hi-result"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('已创建求职流程');
    wrapper.unmount();
  });

  it('丢弃草稿会话不写入正式数据', async () => {
    const session = makeSession({ status: 'preview_generated' });
    mocks.getSessionBundle.mockResolvedValue(bundleWith(session, [makeDraft()]));
    mocks.createSession.mockResolvedValue(makeSession());
    mocks.discardSession.mockResolvedValue({ ...session, status: 'discarded' });
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="hi-new-session"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="hi-discard"]').trigger('click');
    await flushPromises();
    expect(mocks.discardSession).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
