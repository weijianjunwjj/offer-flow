import { mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApplication, makeEvent } from '../../domain/job-memory/testFixtures';
import { projectApplication, type ApplicationMemory } from '../../domain/job-memory';
import ApplicationSection from './ApplicationSection.vue';
import { fingerprintApplicationDrafts } from './applicationSectionModel';
import type { ApplicationDraftState } from './applicationSectionModel';
import { createEmptyEventDraft, fingerprintEventDrafts } from './feedbackTimelineModel';

const mocks = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock('./sectionScope', () => ({
  useInjectedDetailScope: () => mocks.scope,
}));

function application(id: string, createdAt: number): ApplicationMemory {
  const record = makeApplication({ id, createdAt, updatedAt: createdAt, channel: 'boss' });
  const events = [makeEvent('application_created', { applicationId: id, createdAt, eventAt: createdAt })];
  return { record, events, projection: projectApplication(record, events) };
}

function createScope(applications: ApplicationMemory[] = []) {
  const drafts: ApplicationDraftState = {
    create: null, edit: null, void: null, baselineFingerprint: '',
  };
  drafts.baselineFingerprint = fingerprintApplicationDrafts(drafts);
  const scope = reactive({
    $id: 'job-detail',
    $source: {
      bundle: {
        jobId: 'job-1',
        job: { id: 'job-1', city: '苏州' },
        profile: null,
        allJobs: [],
        applicationSummariesByJob: { 'job-1': [] },
        memory: { applications, resumeVersions: [], activeResumeVersionId: null },
      },
    },
    selectedApplicationId: null as string | null,
    applicationDrafts: drafts,
    eventDraft: null as ReturnType<typeof createEmptyEventDraft> | null,
    eventVoidDraft: null,
    eventDraftBaselineFingerprint: fingerprintEventDrafts(null, null),
    actionStatus: {} as Record<string, string>,
    createApplication: vi.fn(async () => {
      scope.applicationDrafts = { create: null, edit: null, void: null, baselineFingerprint: '' };
      scope.applicationDrafts.baselineFingerprint = fingerprintApplicationDrafts(scope.applicationDrafts);
      return scope.$source.bundle.memory;
    }),
    updateApplication: vi.fn(),
    voidApplication: vi.fn(),
    resetEventDrafts: vi.fn(() => {
      scope.eventDraft = null;
      scope.eventVoidDraft = null;
      scope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
    }),
  });
  Object.defineProperty(scope, 'isApplicationDirty', {
    get: () => fingerprintApplicationDrafts(scope.applicationDrafts)
      !== scope.applicationDrafts.baselineFingerprint,
  });
  Object.defineProperty(scope, 'isEventDirty', {
    get: () => fingerprintEventDrafts(scope.eventDraft, scope.eventVoidDraft)
      !== scope.eventDraftBaselineFingerprint,
  });
  return scope;
}

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ApplicationSection', () => {
  it('零流程只显示人工创建入口，确认前不写入；重复创建使用新幂等键', async () => {
    const scope = createScope();
    mocks.scope = scope;
    const wrapper = mount(ApplicationSection, { props: { scopeRequired: true } });
    expect(wrapper.text()).toContain('还没有求职流程');
    expect(scope.createApplication).not.toHaveBeenCalled();

    await wrapper.find('.section-head .primary-btn').trigger('click');
    const firstKey = scope.applicationDrafts.create?.idempotencyKey;
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    await wrapper.find('.modal-actions .primary-btn').trigger('click');
    expect(scope.createApplication).toHaveBeenCalledTimes(1);
    expect(scope.createApplication).toHaveBeenLastCalledWith(expect.objectContaining({
      idempotencyKey: firstKey,
      initialEvent: expect.objectContaining({ eventType: 'applied', eventAt: null, timePrecision: 'unknown' }),
    }));

    await wrapper.find('.section-head .primary-btn').trigger('click');
    const secondKey = scope.applicationDrafts.create?.idempotencyKey;
    expect(secondKey).not.toBe(firstKey);
  });

  it('多流程标记共享默认项，选择只改变 Page Scope UI 状态', async () => {
    const older = application('older', 10);
    const newer = application('newer', 20);
    const scope = createScope([older, newer]);
    mocks.scope = scope;
    const wrapper = mount(ApplicationSection, { props: { scopeRequired: true } });
    const cards = wrapper.findAll('.application-card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.text()).toContain('默认');
    expect(cards[0]?.text()).toContain('newer');
    await cards[1]?.find('.card-select').trigger('click');
    expect(scope.selectedApplicationId).toBe('older');
    expect(scope.updateApplication).not.toHaveBeenCalled();
  });

  it('切换 Application 时 dirty Event 草稿必须确认，拒绝则不串流程', async () => {
    const older = application('older', 10);
    const newer = application('newer', 20);
    const scope = createScope([older, newer]);
    scope.selectedApplicationId = 'newer';
    scope.eventDraft = createEmptyEventDraft('boss');
    scope.eventDraft.note = '属于 newer 的草稿';
    mocks.scope = scope;
    const wrapper = mount(ApplicationSection, { props: { scopeRequired: true } });
    const olderCard = wrapper.findAll('.application-card').find((card) => card.text().includes('older'))!;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await olderCard.get('.card-select').trigger('click');
    expect(scope.selectedApplicationId).toBe('newer');
    expect(scope.eventDraft?.note).toBe('属于 newer 的草稿');
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await olderCard.get('.card-select').trigger('click');
    expect(scope.selectedApplicationId).toBe('older');
    expect(scope.eventDraft).toBeNull();
  });

  it('关闭脏草稿前确认，拒绝放弃时保留，确认后清空', async () => {
    const scope = createScope();
    mocks.scope = scope;
    const wrapper = mount(ApplicationSection, { props: { scopeRequired: true } });
    await wrapper.find('.section-head .primary-btn').trigger('click');
    const input = wrapper.find('input[placeholder="可留空"]');
    await input.setValue('招聘主体');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wrapper.find('.close-btn').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    await wrapper.find('.close-btn').trigger('click');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });
});
