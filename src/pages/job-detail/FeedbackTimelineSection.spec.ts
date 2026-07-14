import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectApplication,
  type ApplicationMemory,
  type FeedbackEventRecord,
} from '../../domain/job-memory';
import { makeApplication, makeEvent, makeLegacyEvent, makeVoidEvent } from '../../domain/job-memory/testFixtures';
import FeedbackTimelineSection from './FeedbackTimelineSection.vue';
import {
  fingerprintEventDrafts,
  type FeedbackEventDraft,
  type FeedbackEventVoidDraft,
} from './feedbackTimelineModel';

const mocks = vi.hoisted(() => ({ scope: null as unknown }));

vi.mock('./sectionScope', () => ({ useInjectedDetailScope: () => mocks.scope }));

function application(events: FeedbackEventRecord[], overrides = {}): ApplicationMemory {
  const record = makeApplication(overrides);
  return { record, events, projection: projectApplication(record, events) };
}

function createScope(current: ApplicationMemory | null) {
  const scope = reactive({
    $id: 'job-detail',
    $source: {
      bundle: {
        jobId: 'job-1', job: { id: 'job-1' }, profile: null, allJobs: [],
        applicationSummariesByJob: { 'job-1': [] },
        memory: {
          applications: current === null ? [] : [current],
          resumeVersions: [], activeResumeVersionId: null,
        },
      },
    },
    selectedApplicationId: current?.record.id ?? null,
    eventDraft: null as FeedbackEventDraft | null,
    eventVoidDraft: null as FeedbackEventVoidDraft | null,
    eventDraftBaselineFingerprint: fingerprintEventDrafts(null, null),
    timelineUi: { composerExpanded: false, focusedEventId: null as string | null },
    actionStatus: {} as Record<string, string>,
    appendFeedbackEvent: vi.fn().mockResolvedValue(null),
    voidFeedbackEvent: vi.fn().mockResolvedValue(null),
    resetEventDrafts: vi.fn(() => {
      scope.eventDraft = null;
      scope.eventVoidDraft = null;
      scope.eventDraftBaselineFingerprint = fingerprintEventDrafts(null, null);
      scope.timelineUi = { composerExpanded: false, focusedEventId: null };
    }),
  });
  Object.defineProperty(scope, 'isEventDirty', {
    get: () => fingerprintEventDrafts(scope.eventDraft, scope.eventVoidDraft)
      !== scope.eventDraftBaselineFingerprint,
  });
  return scope;
}

beforeEach(() => vi.stubGlobal('confirm', vi.fn().mockReturnValue(true)));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FeedbackTimelineSection', () => {
  it('展示普通、审计、legacy、未知时间及投影诊断边界', () => {
    const created = makeEvent('application_created', { id: 'created', idempotencyKey: 'created' });
    const unknown = makeEvent('greeting_sent', {
      id: 'unknown', idempotencyKey: 'unknown', eventAt: null, timePrecision: 'unknown', createdAt: 2_000,
    });
    const legacy = makeLegacyEvent({ id: 'legacy', idempotencyKey: 'legacy', createdAt: 500 });
    mocks.scope = createScope(application([created, unknown, legacy]));
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    expect(wrapper.text()).toContain('事实事件推导出的当前流程状态');
    expect(wrapper.text()).toContain('发生时间未知');
    expect(wrapper.text()).toContain('记录时间');
    expect(wrapper.text()).toContain('系统审计');
    expect(wrapper.text()).toContain('迁移兼容');
    expect(wrapper.text()).toContain('弱证据 / 系统推断');
    for (const raw of [
      'stage', 'outcome', 'communicationStatus', 'followUpCount', 'nextAllowedFollowUpAt',
      'lastMeaningfulEventAt', 'projectionStatus', 'direct_employer', 'not_contacted',
      'application_created', 'sourceConfidence', 'evidenceLevel', 'timePrecision', 'LEGACY_SEED_APPLIED',
    ]) {
      expect(wrapper.text()).not.toContain(raw);
    }
  });

  it('不可用投影默认显示中文摘要，原始诊断只在技术信息展开后出现', async () => {
    const current = application([makeEvent('application_created')]);
    current.projection = {
      ...current.projection,
      projectionStatus: 'invalid',
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: '投影输出损坏' }],
    };
    mocks.scope = createScope(current);
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    expect(wrapper.get('.projection-invalid').text()).toContain('投影不可用');
    expect(wrapper.text()).toContain('1 项技术提示');
    expect(wrapper.text()).not.toContain('INVALID_PROJECTION_OUTPUT');
    const details = wrapper.get('details.technical-info');
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger('toggle');
    expect(wrapper.text()).toContain('INVALID_PROJECTION_OUTPUT');
  });

  it('被作废事件不消失，展示原因、作废时间和 replacement 关联', () => {
    const target = makeEvent('rejected', { id: 'target', idempotencyKey: 'target-key' });
    const voidEvent = makeVoidEvent(target, { id: 'void', idempotencyKey: 'void-key' });
    const replacement = makeEvent('hr_replied', {
      id: 'replacement', idempotencyKey: 'void-key:replacement', createdAt: voidEvent.createdAt,
    });
    mocks.scope = createScope(application([target, voidEvent, replacement]));
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    const targetCard = wrapper.get('[data-event-id="target"]');
    expect(targetCard.text()).toContain('已作废');
    expect(targetCard.text()).toContain('作废原因：修正误录事件');
    expect(targetCard.text()).toContain('作废记录时间');
    expect(targetCard.text()).toContain('该记录已由另一条记录替代');
    expect(targetCard.find('.correct-btn').exists()).toBe(false);
  });

  it('手工表单只列普通白名单，显示预览，unknown 提交为 null 且不自动写入', async () => {
    const current = application([makeEvent('application_created')]);
    const scope = createScope(current);
    mocks.scope = scope;
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    expect(scope.appendFeedbackEvent).not.toHaveBeenCalled();
    await wrapper.get('.section-head .primary-btn').trigger('click');
    const options = wrapper.findAll('select[data-event-type] option').map((option) => option.attributes('value'));
    expect(options).toContain('applied');
    expect(options).toContain('no_response_recorded');
    expect(options).not.toContain('event_voided');
    expect(options).not.toContain('application_created');
    expect(wrapper.get('[role="dialog"]').text()).not.toContain('applied');
    expect(wrapper.get('[role="dialog"]').text()).not.toContain('sourceConfidence');
    expect(wrapper.get('[data-fact-preview]').text()).toContain('事实预览');
    const key = scope.eventDraft?.idempotencyKey;
    await wrapper.get('.modal-actions .primary-btn').trigger('click');
    expect(scope.appendFeedbackEvent).toHaveBeenCalledWith(current.record.id, expect.objectContaining({
      idempotencyKey: key,
      expectedApplicationVersion: current.record.rowVersion,
      eventAt: null,
      timePrecision: 'unknown',
    }));
  });

  it('高影响事件和关闭后补录必须二次确认，取消时不写入', async () => {
    const current = application([makeEvent('application_created')]);
    const scope = createScope(current);
    mocks.scope = scope;
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    await wrapper.get('.section-head .primary-btn').trigger('click');
    await wrapper.get('select[data-event-type]').setValue('rejected');
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await wrapper.get('.modal-actions .primary-btn').trigger('click');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('是否关闭投影：是'));
    expect(scope.appendFeedbackEvent).not.toHaveBeenCalled();
  });

  it('普通业务事件可纠正并在一次 void 命令中携带 replacement', async () => {
    const target = makeEvent('greeting_sent', { id: 'target', idempotencyKey: 'target-key' });
    const current = application([target]);
    const scope = createScope(current);
    mocks.scope = scope;
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    await wrapper.get('[data-event-id="target"] .correct-btn').trigger('click');
    await wrapper.get('[data-void-reason]').setValue('实际是 HR 回复');
    await wrapper.get('.replace-toggle input').setValue(true);
    await wrapper.findAll('select[data-event-type]').at(0)!.setValue('hr_replied');
    const key = scope.eventVoidDraft?.idempotencyKey;
    await wrapper.get('.modal-actions .danger-btn').trigger('click');
    await flushPromises();
    expect(scope.voidFeedbackEvent).toHaveBeenCalledWith('target', expect.objectContaining({
      idempotencyKey: key,
      expectedApplicationVersion: current.record.rowVersion,
      reason: '实际是 HR 回复',
      replacementEvent: expect.objectContaining({ eventType: 'hr_replied' }),
    }));
  });

  it('已作废 Application 完全禁止新增和纠错', () => {
    const event = makeEvent('applied');
    const current = application([event], { voidedAt: 2_000, voidReason: '流程误录' });
    mocks.scope = createScope(current);
    const wrapper = mount(FeedbackTimelineSection, { props: { scopeRequired: true } });
    expect(wrapper.text()).toContain('当前求职流程已作废');
    expect(wrapper.find('.section-head .primary-btn').exists()).toBe(false);
    expect(wrapper.find('.correct-btn').exists()).toBe(false);
  });
});
