import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { scopeRegistry } from 'vue-page-scope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { injectJobDetailScope, useJobDetailScope } from './jobDetailScope';
import type { JobDetailApiPorts } from './jobDetailTypes';

function makeJob(id: string, updatedAt = 1): JobRecord {
  return {
    id,
    createdAt: 1,
    updatedAt,
    company: `公司-${id}`,
    role: `岗位-${id}`,
    city: '苏州',
    salaryRange: '20K',
    jdText: 'JD',
    promptText: '',
    aiRawResult: '',
    aiPastedAt: null,
    parseStatus: 'none',
    report: null,
    matchScore: '',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'not_contacted',
    followupCount: 0,
  };
}

function apiFor(jobId: string): JobDetailApiPorts {
  const job = makeJob(jobId);
  return {
    jobs: {
      get: vi.fn().mockResolvedValue(job),
      list: vi.fn().mockResolvedValue([job]),
      patch: vi.fn().mockImplementation(async (_id, patch) => ({ ...job, ...patch, updatedAt: 2 })),
    },
    profile: { get: vi.fn().mockResolvedValue(null) },
  };
}

const InjectedSection = defineComponent({
  setup() {
    const scope = injectJobDetailScope();
    return () => h('span', { 'data-section-scope': '' }, scope?.$id ?? 'missing');
  },
});

const Owner = defineComponent({
  props: { jobId: { type: String, required: true } },
  setup(props) {
    const scope = useJobDetailScope({ jobId: props.jobId, api: apiFor(props.jobId) });
    return () => h('div', [h(InjectedSection), h('b', scope.$source.bundle?.job.id ?? 'loading')]);
  },
});

afterEach(() => {
  scopeRegistry.get('job-detail')?.$destroy();
});

describe('岗位详情 Page Scope', () => {
  it('owner 与 Section 注入同一 Scope，并由 acceptBundle 建立 source/draft', async () => {
    const wrapper = mount(Owner, { props: { jobId: 'A' } });
    await flushPromises();
    const scope = scopeRegistry.get('job-detail');
    expect(scope).toBeTruthy();
    expect(wrapper.get('[data-section-scope]').text()).toBe('job-detail');
    expect(scope?.$source.bundle.job.id).toBe('A');
    expect(scope?.$state.jobDraft.company).toBe('公司-A');
    expect(scope?.$state.baselineFingerprint).not.toBe('');
    wrapper.unmount();
    expect(scopeRegistry.has('job-detail')).toBe(false);
  });

  it('acceptUpdatedJob 同步 job 与 allJobs，且非确认写不清理分析草稿', async () => {
    const wrapper = mount(Owner, { props: { jobId: 'A' } });
    await flushPromises();
    const detailScope = scopeRegistry.get('job-detail');
    detailScope?.$patch({ analysisDraft: { rawText: '未确认', dirty: true, streamRunId: 1, error: '' } });
    const updated = makeJob('A', 9);
    updated.company = '新公司';
    (detailScope as ReturnType<typeof useJobDetailScope>).acceptUpdatedJob(updated);
    expect(detailScope?.$source.bundle.job.company).toBe('新公司');
    expect(detailScope?.$source.bundle.allJobs.find((job: JobRecord) => job.id === 'A')?.company).toBe('新公司');
    expect(detailScope?.$state.jobDraft.company).toBe('新公司');
    expect(detailScope?.$state.analysisDraft.rawText).toBe('未确认');
    wrapper.unmount();
  });

  it('真实 keyed 组件 A→B→C 不重叠注册，最终只保留当前 owner', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const Host = defineComponent({
      props: { jobId: { type: String, required: true } },
      setup(props) {
        return () => h(Owner, { key: props.jobId, jobId: props.jobId });
      },
    });
    const wrapper = mount(Host, { props: { jobId: 'A' } });
    await flushPromises();
    for (const jobId of ['B', 'C']) {
      await wrapper.setProps({ jobId });
      await nextTick();
      await flushPromises();
      expect(scopeRegistry.size).toBe(1);
      expect(scopeRegistry.get('job-detail')?.$source.bundle.job.id).toBe(jobId);
    }
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warningSpy.mock.calls.flat().join(' ')).not.toContain('already exists');
    wrapper.unmount();
    expect(scopeRegistry.size).toBe(0);
  });
});
