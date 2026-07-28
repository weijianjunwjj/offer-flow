/**
 * RC-11 反向追踪面板组件测试。
 *
 * 重点：忠实透传服务端状态，绝不臆测——
 * 未记录触发原因 / 动作缺失 / 已撤销、批次成员推断 + wasSelected、
 * 无来源明确不可追溯、link 模式一对象多晋升、只读（无删除/修改/修复按钮）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormalObjectTrace, PromotionOriginTrace } from '../../api/radarPromotionTraceApi';
import RadarPromotionTracePanel from './RadarPromotionTracePanel.vue';

const mocks = vi.hoisted(() => ({ traceByPromotion: vi.fn(), traceByObject: vi.fn() }));
vi.mock('../../api/radarPromotionTraceApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarPromotionTraceApi')>();
  return { ...actual, radarPromotionTraceApi: mocks };
});

function origin(over: Partial<PromotionOriginTrace> = {}): PromotionOriginTrace {
  return {
    promotionId: 'promo-1', promotionType: 'feedback', candidateId: 'cand-1',
    jobId: 'job-1', applicationId: 'app-1', feedbackEventId: 'ev-1', createdAt: 1_800_000_000,
    candidateVersion: {
      status: 'resolved', candidateId: 'cand-1', candidateVersionId: 'cv-1', versionNo: 1,
      contentHash: 'h', originType: 'capture', sourceSnapshotIds: ['s1'], createdAt: 1,
    },
    trigger: { status: 'not_recorded' },
    recommendationBatches: { status: 'no_batch' },
    ...over,
  };
}

beforeEach(() => { mocks.traceByPromotion.mockReset(); mocks.traceByObject.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('正向：晋升 → 来源链', () => {
  it('传入 promotionId 自动加载并展示候选版本/正向对象', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin());
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    expect(mocks.traceByPromotion).toHaveBeenCalledWith('promo-1');
    expect(w.find('[data-testid="trace-origin"]').exists()).toBe(true);
    expect(w.find('[data-testid="origin-candidate-version"]').text()).toContain('cv-1');
  });

  it('promotionId 为空不加载来源链', async () => {
    mount(RadarPromotionTracePanel, { props: { promotionId: null } });
    await flushPromises();
    expect(mocks.traceByPromotion).not.toHaveBeenCalled();
  });

  it('未记录触发原因 → 显示「未记录」', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin({ trigger: { status: 'not_recorded' } }));
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    expect(w.find('[data-testid="origin-trigger-not-recorded"]').text()).toContain('未记录');
  });

  it('动作记录缺失 → 显示「动作记录缺失」', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin({ trigger: { status: 'action_missing', triggerActionId: 'a-x' } }));
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    expect(w.find('[data-testid="origin-trigger-missing"]').text()).toContain('动作记录缺失');
  });

  it('已撤销触发动作 → 显示「已撤销，但正式事实链路保留」', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin({
      trigger: {
        status: 'resolved', actionId: 'a1', actionType: 'marked_priority', reasonCode: null,
        reasonText: '重点', occurredAt: 1, reverted: true, revertedByActionId: 'a2',
      },
    }));
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    expect(w.find('[data-testid="origin-trigger-reverted"]').text()).toContain('正式事实链路保留');
  });

  it('批次成员推断：标注「按…成员关系推断」并展示 wasSelected', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin({
      recommendationBatches: {
        status: 'linked_by_scope_membership',
        batches: [
          { batchId: 'b1', batchKey: 'k1', status: 'succeeded', diagnosisStatus: 'formed', emptyReason: null, generatedAt: 1, wasSelected: true },
          { batchId: 'b2', batchKey: 'k2', status: 'succeeded', diagnosisStatus: 'formed', emptyReason: null, generatedAt: 1, wasSelected: false },
        ],
      },
    }));
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    expect(w.find('[data-testid="origin-batches-inferred"]').text()).toContain('推断');
    expect(w.find('[data-testid="origin-batch-selected-b1"]').text()).toContain('进入建议');
    expect(w.find('[data-testid="origin-batch-selected-b2"]').text()).toContain('仅在 scope 内');
  });

  it('无删除/修改/自动修复按钮（纯只读追溯）', async () => {
    mocks.traceByPromotion.mockResolvedValue(origin());
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: 'promo-1' } });
    await flushPromises();
    const texts = w.findAll('button').map((b) => b.text());
    for (const t of texts) {
      expect(t).not.toMatch(/删除|修改|修复/);
    }
  });
});

describe('反向：反查正式对象来源', () => {
  async function lookup(result: FormalObjectTrace) {
    mocks.traceByObject.mockResolvedValue(result);
    const w = mount(RadarPromotionTracePanel, { props: { promotionId: null } });
    await w.find('[data-testid="trace-lookup-id"] input').setValue('job-x');
    await w.find('[data-testid="trace-lookup-run"]').trigger('click');
    await flushPromises();
    return w;
  }

  it('无来源 → 明确不可追溯（不编造）', async () => {
    const w = await lookup({ objectKind: 'job', objectId: 'job-x', traceable: false, reason: 'no_promotion' });
    expect(w.find('[data-testid="trace-lookup-untraceable"]').exists()).toBe(true);
    expect(w.find('[data-testid="trace-lookup-untraceable"]').text()).toContain('不可追溯');
  });

  it('link 模式：一对象对应多份晋升，全部列出并提示', async () => {
    const w = await lookup({
      objectKind: 'job', objectId: 'job-x', traceable: true,
      promotions: [origin({ promotionId: 'p1' }), origin({ promotionId: 'p2' })],
    });
    expect(w.find('[data-testid="trace-lookup-count"]').text()).toContain('2 条');
    expect(w.find('[data-testid="trace-lookup-count"]').text()).toContain('link 模式');
    expect(w.find('[data-testid="trace-lookup-origin-p1"]').exists()).toBe(true);
    expect(w.find('[data-testid="trace-lookup-origin-p2"]').exists()).toBe(true);
  });

  it('单条引用不显示 link 模式提示', async () => {
    const w = await lookup({
      objectKind: 'application', objectId: 'app-x', traceable: true, promotions: [origin({ promotionId: 'p1' })],
    });
    expect(w.find('[data-testid="trace-lookup-count"]').text()).toContain('1 条');
    expect(w.find('[data-testid="trace-lookup-count"]').text()).not.toContain('link 模式');
  });
});
