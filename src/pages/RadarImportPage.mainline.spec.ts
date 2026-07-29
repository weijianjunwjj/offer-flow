/**
 * V8-UX 主线整合：采集页导航接线测试。
 *
 * 覆盖：三阶段步骤条（collect 高亮）+ 三问引导条常驻；写入成功后出现唯一主
 * CTA「去审核岗位」并路由到 radar-review（真实 memory router + 监视 push）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import RadarImportPage from './RadarImportPage.vue';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), commitSession: vi.fn() }));
vi.mock('../api/radarApi', () => ({ radarApi: mocks }));

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function sessionView() {
  return {
    session: {
      id: SESSION_ID, sourceType: 'browser', status: 'preview',
      createdAt: 1, expiresAt: Date.now() + 60_000, committedAt: null,
    },
    items: [{
      index: 0, captureMethod: 'boss_current_page', providerKey: 'boss_zhipin', providerVersion: null,
      sourceUrl: 'https://www.zhipin.com/job_detail/ABC.html', sourceDomain: 'www.zhipin.com',
      normalizedSourceUrl: 'https://www.zhipin.com/job_detail/ABC.html', pageTitle: '测试岗位',
      visibleText: '职位描述', externalRecordId: 'ABC',
      recognizedFields: {
        company: '测试科技', role: '前端工程师', city: '苏州',
        salaryMinK: 10, salaryMaxK: 14, salaryPeriod: 'month',
        experienceRequirement: '3-5年', educationRequirement: '本科',
      },
      extractionMetadata: { kind: 'boss_batch_capture', batchItemStatus: 'captured', commitBlocked: false, activityStatus: '刚刚活跃' },
      correctionNote: null, capturedAt: 1, rawContentHash: 'hash',
    }],
  };
}

const Blank = { template: '<div />' };
function makeRouter(): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/radar/import', name: 'radar-import', component: RadarImportPage },
      { path: '/radar/review', name: 'radar-review', component: Blank },
      { path: '/jobs', name: 'jobs', component: Blank },
    ],
  });
  router.push('/radar/import');
  return router;
}

async function mountPage() {
  const router = makeRouter();
  await router.isReady();
  const push = vi.spyOn(router, 'push');
  const wrapper = mount(RadarImportPage, {
    props: { sessionId: SESSION_ID },
    global: { plugins: [router] },
  });
  await flushPromises();
  return { wrapper, push };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.location.hash = '#/radar/import';
  mocks.getSession.mockResolvedValue(sessionView());
});
afterEach(() => { vi.clearAllMocks(); });

describe('RadarImportPage 主线接线', () => {
  it('渲染步骤条（collect 高亮）与三问引导条', async () => {
    const { wrapper } = await mountPage();
    expect(wrapper.find('[data-testid="radar-stage-stepper"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="radar-stage-collect"]').classes()).toContain('is-active');
    expect(wrapper.find('[data-testid="radar-guide-bar"]').exists()).toBe(true);
  });

  it('步骤条点击 review 路由到审核页', async () => {
    const { wrapper, push } = await mountPage();
    await wrapper.find('[data-testid="radar-stage-review"]').trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'radar-review' });
  });

  it('写入前不显示主 CTA；写入成功后出现「去审核岗位」并路由到审核页', async () => {
    mocks.commitSession.mockResolvedValue({
      session: { ...sessionView().session, status: 'committed', committedAt: 2 },
      outcomes: [{ index: 0, kind: 'created', decisionType: 'new_identity', analysisEligible: true, candidateId: 'cand-xyz-01' }],
    });
    const { wrapper, push } = await mountPage();
    expect(wrapper.find('[data-testid="radar-next-action"]').exists()).toBe(false);

    await wrapper.find('[data-testid="radar-commit"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="radar-result"]').exists()).toBe(true);
    const cta = wrapper.find('[data-testid="radar-next-action-cta"]');
    expect(cta.exists()).toBe(true);
    await cta.trigger('click');
    expect(push).toHaveBeenCalledWith({ name: 'radar-review' });
  });
});
