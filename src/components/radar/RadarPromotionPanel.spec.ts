/**
 * V8-6 晋升面板组件测试。
 *
 * 重点：Human-in-the-loop——预览不写库、确认必须是第二次独立动作、
 * 无任何自动晋升路径；以及钳制/link/create 的如实展示与安全错误提示。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NSelect } from 'naive-ui';
import { ApiError } from '../../api/client';
import type { PromotionPlanView, PromotionView } from '../../api/radarPromotionApi';
import RadarPromotionPanel from './RadarPromotionPanel.vue';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), promote: vi.fn() }));
vi.mock('../../api/radarPromotionApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarPromotionApi')>();
  return { ...actual, radarPromotionApi: mocks };
});

// 晋升面板内嵌 RC-11 追踪面板：确认晋升后子组件会按 promotionId 拉取来源链。
// 这里桩掉追踪 API，隔离本 spec 的关注点（晋升流程），避免子组件触发真实 fetch。
const traceMocks = vi.hoisted(() => ({ traceByPromotion: vi.fn(), traceByObject: vi.fn() }));
vi.mock('../../api/radarPromotionTraceApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarPromotionTraceApi')>();
  return { ...actual, radarPromotionTraceApi: traceMocks };
});

function plan(over: Partial<PromotionPlanView> = {}): PromotionPlanView {
  return {
    candidateId: 'cand-1', candidateVersionId: 'cv-1',
    trigger: 'hr_replied', requestedDepth: 'feedback', effectiveDepth: 'feedback',
    jobMode: 'create', applicationMode: 'create', feedbackMode: 'create',
    feedbackEventType: 'hr_replied', clampReasons: [],
    existingPromotionId: null, linkedJobId: null, linkedApplicationId: null, ...over,
  };
}

function promotion(over: Partial<PromotionView> = {}): PromotionView {
  return {
    id: 'promo-1', candidateId: 'cand-1', candidateVersionId: 'cv-1', promotionType: 'feedback',
    jobId: 'job-1', applicationId: 'app-1', feedbackEventId: 'ev-1', triggerActionId: null,
    createdAt: 1_800_000_000, ...over,
  };
}

function render(props: Partial<{ candidateVersionId: string | null; enabled: boolean }> = {}) {
  return mount(RadarPromotionPanel, {
    props: { candidateVersionId: 'cv-1', enabled: true, ...props },
  });
}

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.promote.mockReset();
  traceMocks.traceByPromotion.mockReset();
  traceMocks.traceByObject.mockReset();
  traceMocks.traceByPromotion.mockResolvedValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('晋升面板 · 预览零写入与 Human-in-the-loop', () => {
  it('挂载时不调用任何接口（无自动晋升）', async () => {
    render();
    await flushPromises();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it('预览只调用 preview，绝不调用 promote', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    const w = render();

    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(w.find('[data-testid="promotion-plan"]').exists()).toBe(true);
  });

  it('未预览时确认按钮不可用（强制先看后做）', async () => {
    const w = render();
    await flushPromises();

    const confirm = w.find('[data-testid="promotion-confirm"]');
    expect(confirm.attributes('disabled')).toBeDefined();
  });

  it('确认是第二次独立动作：预览后点击确认才写库', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    mocks.promote.mockResolvedValue({ promotion: promotion(), plan: plan(), created: true });
    const w = render();

    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();
    expect(mocks.promote).not.toHaveBeenCalled();

    await w.find('[data-testid="promotion-confirm"]').trigger('click');
    await flushPromises();

    expect(mocks.promote).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="promotion-result"]').exists()).toBe(true);
  });

  it('改动触发原因后旧计划作废，必须重新预览', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="promotion-plan"]').exists()).toBe(true);

    // 第一个 NSelect 是触发原因；直接发 update:value 模拟用户改选。
    await w.findAllComponents(NSelect)[0]!.vm.$emit('update:value', 'user_priority');
    await flushPromises();

    expect(w.find('[data-testid="promotion-plan"]').exists()).toBe(false);
    expect(w.find('[data-testid="promotion-confirm"]').attributes('disabled')).toBeDefined();
  });
});

describe('晋升面板 · 计划展示', () => {
  it('展示请求深度与实际深度', async () => {
    mocks.preview.mockResolvedValue({ plan: plan({ requestedDepth: 'feedback', effectiveDepth: 'feedback' }) });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-requested-depth"]').text()).toContain('岗位 + 投递 + 反馈事件');
    expect(w.find('[data-testid="promotion-effective-depth"]').text()).toContain('岗位 + 投递 + 反馈事件');
  });

  it('深度被钳制时显著提示，并给出可读原因', async () => {
    mocks.preview.mockResolvedValue({
      plan: plan({
        requestedDepth: 'feedback', effectiveDepth: 'job_only',
        applicationMode: 'none', feedbackMode: 'none', feedbackEventType: null,
        clampReasons: ['trigger_forbids_application'],
      }),
    });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-clamped"]').exists()).toBe(true);
    expect(w.find('[data-testid="promotion-effective-depth"]').text()).toContain('仅岗位');
    expect(w.find('[data-testid="promotion-clamp-trigger_forbids_application"]').text())
      .toContain('已降到仅建岗位');
  });

  it('link 模式展示"关联既有"与目标 ID', async () => {
    mocks.preview.mockResolvedValue({
      plan: plan({ jobMode: 'link', linkedJobId: 'job-existing', applicationMode: 'create' }),
    });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    const job = w.find('[data-testid="promotion-object-job"]');
    expect(job.text()).toContain('关联既有');
    expect(job.text()).toContain('job-existing');
    expect(w.find('[data-testid="promotion-object-application"]').text()).toContain('新建');
  });

  it('create/none 模式分别展示"新建"与"不涉及"', async () => {
    mocks.preview.mockResolvedValue({
      plan: plan({ jobMode: 'create', applicationMode: 'none', feedbackMode: 'none', feedbackEventType: null }),
    });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-object-job"]').text()).toContain('新建');
    expect(w.find('[data-testid="promotion-object-application"]').text()).toContain('不涉及');
    expect(w.find('[data-testid="promotion-object-feedback"]').text()).toContain('不涉及');
  });

  it('展示将创建的反馈事件类型', async () => {
    mocks.preview.mockResolvedValue({ plan: plan({ feedbackEventType: 'interview_scheduled' }) });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-event-type"]').text()).toContain('已约面试');
  });

  it('已晋升过时提示不会再建一份', async () => {
    mocks.preview.mockResolvedValue({
      plan: plan({ clampReasons: ['already_promoted'], existingPromotionId: 'promo-old' }),
    });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-clamp-already_promoted"]').text()).toContain('不会再建一份');
  });
});

describe('晋升面板 · 结果与错误', () => {
  it('成功后展示各正式对象 ID', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    mocks.promote.mockResolvedValue({ promotion: promotion(), plan: plan(), created: true });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();
    await w.find('[data-testid="promotion-confirm"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-result-job"]').text()).toContain('job-1');
    expect(w.find('[data-testid="promotion-result-application"]').text()).toContain('app-1');
    expect(w.find('[data-testid="promotion-result-feedback"]').text()).toContain('ev-1');
    expect(w.find('[data-testid="promotion-result-id"]').text()).toContain('promo-1');
  });

  it('job_only 结果只展示岗位 ID，不臆造投递/事件 ID', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    mocks.promote.mockResolvedValue({
      promotion: promotion({ applicationId: null, feedbackEventId: null, promotionType: 'job_only' }),
      plan: plan({ effectiveDepth: 'job_only' }), created: true,
    });
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();
    await w.find('[data-testid="promotion-confirm"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-result-job"]').exists()).toBe(true);
    expect(w.find('[data-testid="promotion-result-application"]').exists()).toBe(false);
    expect(w.find('[data-testid="promotion-result-feedback"]').exists()).toBe(false);
  });

  it('no_response 被后端拒绝时显示安全错误，且不展示计划', async () => {
    mocks.preview.mockRejectedValue(new ApiError('该触发原因不允许晋升', 409));
    const w = render();

    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-error"]').text()).toContain('该触发原因不允许晋升');
    expect(w.find('[data-testid="promotion-plan"]').exists()).toBe(false);
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it('非 ApiError 异常不外泄原文，只显示兜底文案', async () => {
    mocks.preview.mockRejectedValue(new Error('sqlite: UNIQUE constraint failed: radar_promotions.id'));
    const w = render();

    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();

    const text = w.find('[data-testid="promotion-error"]').text();
    expect(text).toContain('预览晋升计划失败');
    expect(text).not.toContain('sqlite');
    expect(text).not.toContain('radar_promotions');
  });

  it('晋升失败时不展示成功结果', async () => {
    mocks.preview.mockResolvedValue({ plan: plan() });
    mocks.promote.mockRejectedValue(new ApiError('指定的投递已作废，不能晋升', 409));
    const w = render();
    await w.find('[data-testid="promotion-preview"]').trigger('click');
    await flushPromises();
    await w.find('[data-testid="promotion-confirm"]').trigger('click');
    await flushPromises();

    expect(w.find('[data-testid="promotion-error"]').text()).toContain('已作废');
    expect(w.find('[data-testid="promotion-result"]').exists()).toBe(false);
  });

  it('未选候选时只显示引导，不显示表单', async () => {
    const w = render({ candidateVersionId: null });
    await flushPromises();

    expect(w.find('[data-testid="promotion-needs-candidate"]').exists()).toBe(true);
    expect(w.find('[data-testid="promotion-form"]').exists()).toBe(false);
  });

  it('未开启时不显示任何操作', async () => {
    const w = render({ enabled: false });
    await flushPromises();

    expect(w.find('[data-testid="promotion-disabled"]').exists()).toBe(true);
    expect(w.find('[data-testid="promotion-preview"]').exists()).toBe(false);
  });
});
