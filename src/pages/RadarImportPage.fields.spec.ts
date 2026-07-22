import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RadarImportPage from './RadarImportPage.vue';

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../api/radarApi', () => ({
  radarApi: {
    getSession: mocks.getSession,
  },
}));

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

describe('RadarImportPage — 学历与招聘者活跃度', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.location.hash = '#/radar/import';
    mocks.getSession.mockResolvedValue({
      session: {
        id: SESSION_ID,
        sourceType: 'browser',
        status: 'preview',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        committedAt: null,
      },
      items: [{
        index: 0,
        captureMethod: 'boss_current_page',
        providerKey: 'boss_zhipin',
        providerVersion: null,
        sourceUrl: 'https://www.zhipin.com/job_detail/ABC123.html',
        sourceDomain: 'www.zhipin.com',
        normalizedSourceUrl: 'https://www.zhipin.com/job_detail/ABC123.html',
        pageTitle: '测试岗位',
        visibleText: '职位描述',
        externalRecordId: 'ABC123',
        recognizedFields: {
          company: '测试科技', role: '前端工程师', city: '苏州',
          salaryMinK: 10, salaryMaxK: 14, salaryPeriod: 'month',
          experienceRequirement: '3-5年', educationRequirement: '全日制本科',
        },
        extractionMetadata: {
          kind: 'boss_batch_capture', batchItemStatus: 'captured', commitBlocked: false,
          activityStatus: '刚刚活跃',
        },
        correctionNote: null,
        capturedAt: 1,
        rawContentHash: 'hash',
      }],
    });
  });

  it('学历可人工纠正，活跃度以只读采集时快照展示', async () => {
    const wrapper = mount(RadarImportPage, { props: { sessionId: SESSION_ID } });
    await flushPromises();

    const education = wrapper.get('[data-testid="radar-education-0"]').get('input');
    expect((education.element as HTMLInputElement).value).toBe('全日制本科');
    await education.setValue('统招本科');
    expect((education.element as HTMLInputElement).value).toBe('统招本科');

    const activity = wrapper.get('[data-testid="radar-activity-0"]').get('input');
    expect((activity.element as HTMLInputElement).value).toBe('刚刚活跃');
    expect(activity.attributes('readonly')).toBeDefined();
    expect(wrapper.text()).toContain('不作为岗位长期事实');
    wrapper.unmount();
  });

  it('不暴露任何手工 JD 输入入口，只展示扩展创建的预览会话', async () => {
    const wrapper = mount(RadarImportPage, { props: { sessionId: SESSION_ID } });
    await flushPromises();

    expect(wrapper.find('[data-testid="radar-text-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="radar-link-form"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="radar-json-form"]').exists()).toBe(false);
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.text()).toContain('当前页采集预览');
    wrapper.unmount();
  });
});
