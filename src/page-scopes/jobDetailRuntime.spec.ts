import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { scopeRegistry } from 'vue-page-scope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { jobDetailTasks, type JobDetailScope, useJobDetailScope } from './jobDetailScope';
import type { JobDetailApiPorts } from './jobDetailTypes';
import { registerPageRuntime } from './registerPageRuntime';
import { ApiError } from '../api/client';

function makeJob(id: string, updatedAt = 1): JobRecord {
  return {
    id, createdAt: 1, updatedAt, company: `公司-${id}`, role: `岗位-${id}`, city: '苏州',
    salaryRange: '20K', jdText: 'JD', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: null, matchScore: '', companyInput: emptyCompanyInput(),
    companyAssessment: null, opportunityAnalysis: null, communicationStatus: 'not_contacted',
    followupCount: 0,
  };
}

function fixedApi(job: JobRecord): JobDetailApiPorts {
  return {
    jobs: {
      get: vi.fn().mockResolvedValue(job),
      list: vi.fn().mockResolvedValue([job]),
      patch: vi.fn(),
    },
    profile: { get: vi.fn().mockResolvedValue(null) },
  };
}

function v2Api(job: JobRecord): JobDetailApiPorts {
  const api = fixedApi(job);
  api.jobMemory = {
    getJobDetailBundle: vi.fn().mockResolvedValue({
      jobId: job.id,
      job,
      profile: null,
      allJobs: [job],
      applicationSummariesByJob: { [job.id]: [] },
      memory: { applications: [], resumeVersions: [], activeResumeVersionId: null },
    }),
    getJobSummaries: vi.fn(),
    createApplication: vi.fn(),
    updateApplication: vi.fn(),
    voidApplication: vi.fn(),
  };
  return api;
}

function mountOwner(
  jobId: string,
  api: JobDetailApiPorts,
  runtimeEnabled: boolean,
  jobMemoryV2Enabled = false,
) {
  const Owner = defineComponent({
    setup() {
      const scope = useJobDetailScope({ jobId, api, runtimeEnabled, jobMemoryV2Enabled });
      return () => h('p', scope.$source.bundle?.job.id ?? 'empty');
    },
  });
  return mount(Owner);
}

function currentScope(): JobDetailScope {
  const scope = scopeRegistry.get('job-detail') as JobDetailScope | undefined;
  if (!scope) throw new Error('job-detail scope 未创建');
  return scope;
}

afterEach(() => {
  scopeRegistry.get('job-detail')?.$destroy();
  vi.restoreAllMocks();
});

describe('Runtime loadJobBundle Gate 1', () => {
  it('plugin 模块幂等注册，公开 $task 可用且 task 不声明 deps', async () => {
    expect(registerPageRuntime()).toBe(false);
    const wrapper = mountOwner('A', fixedApi(makeJob('A')), true);
    await flushPromises();
    expect(typeof currentScope().$task.run).toBe('function');
    expect(typeof currentScope().$task.abort).toBe('function');
    expect(jobDetailTasks.loadJobBundle.trigger).toBe('enter');
    expect('deps' in jobDetailTasks.loadJobBundle).toBe(false);
    wrapper.unmount();
  });

  it('trigger enter 只运行一次，manual retry 复用同一个 task', async () => {
    const api = fixedApi(makeJob('A'));
    const wrapper = mountOwner('A', api, true);
    await flushPromises();
    expect(api.jobs.get).toHaveBeenCalledTimes(1);
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    await currentScope().reloadJobBundle();
    expect(api.jobs.get).toHaveBeenCalledTimes(2);
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    wrapper.unmount();
  });

  it('canRun=false 不请求，reset 同步幂等且保留 analysisDraft', async () => {
    const api = fixedApi(makeJob('unused'));
    const wrapper = mountOwner('', api, true);
    await flushPromises();
    const scope = currentScope();
    expect(api.jobs.get).not.toHaveBeenCalled();
    scope.acceptBundle({ jobId: '', job: makeJob('seed'), profile: null, allJobs: [makeJob('seed')] });
    scope.analysisDraft = { rawText: '未确认', dirty: true, streamRunId: 2, error: '' };
    const first = scope.$task.run('loadJobBundle');
    expect(scope.$source.bundle).toBeNull();
    expect(scope.jobDraft).toBeNull();
    expect(scope.loadError).toBeNull();
    expect(scope.analysisDraft.rawText).toBe('未确认');
    await first;
    await scope.$task.run('loadJobBundle');
    expect(scope.$loading.loadJobBundle).toBe(false);
    wrapper.unmount();
  });

  it('普通错误映射为可重试状态且不触发 Runtime 默认 console.error', async () => {
    const api = fixedApi(makeJob('A'));
    vi.mocked(api.jobs.get).mockRejectedValueOnce(new Error('network down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapper = mountOwner('A', api, true);
    await flushPromises();
    expect(currentScope().loadError).toEqual({ kind: 'error', message: 'network down' });
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('404 映射为岗位不存在，loading 正常恢复', async () => {
    const api = fixedApi(makeJob('missing'));
    vi.mocked(api.jobs.get).mockRejectedValueOnce(new ApiError('missing', 404));
    const wrapper = mountOwner('missing', api, true);
    await flushPromises();
    expect(currentScope().loadError).toEqual({ kind: 'not-found', message: '岗位不存在或已被删除。' });
    expect(currentScope().$source.bundle).toBeNull();
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    wrapper.unmount();
  });

  it('$task.abort 取消 signal 并立即恢复 loading', async () => {
    let receivedSignal: AbortSignal | undefined;
    const api = fixedApi(makeJob('A'));
    vi.mocked(api.jobs.get).mockImplementation((_id, options) => {
      receivedSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const wrapper = mountOwner('A', api, true);
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentScope().$loading.loadJobBundle).toBe(true);
    currentScope().$task.abort('loadJobBundle');
    expect(receivedSignal?.aborted).toBe(true);
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    await flushPromises();
    wrapper.unmount();
  });

  it('manual repeated run abort 旧 signal，忽略 abort 的迟到结果也不能提交', async () => {
    const pending: Array<{ signal?: AbortSignal; resolve(job: JobRecord): void }> = [];
    const api = fixedApi(makeJob('A'));
    vi.mocked(api.jobs.get).mockImplementation((_id, options) => new Promise((resolve) => {
      pending.push({ signal: options?.signal, resolve });
    }));
    const wrapper = mountOwner('A', api, true);
    await wrapper.vm.$nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const retry = currentScope().$task.run('loadJobBundle');
    expect(pending[0]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    pending[1]?.resolve(makeJob('A', 2));
    await retry;
    pending[0]?.resolve(makeJob('A', 1));
    await flushPromises();
    expect(currentScope().$source.bundle?.job.updatedAt).toBe(2);
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    wrapper.unmount();
  });

  it('flag=false 只走 direct，flag=true 只走 Runtime，source/draft 语义一致', async () => {
    const job = makeJob('A');
    const directApi = fixedApi(job);
    const directWrapper = mountOwner('A', directApi, false);
    await flushPromises();
    const directSnapshot = JSON.stringify({
      bundle: currentScope().$source.bundle,
      draft: currentScope().jobDraft,
    });
    expect(directApi.jobs.get).toHaveBeenCalledTimes(1);
    expect(currentScope().$loading.loadJobBundle).toBe(false);
    directWrapper.unmount();

    const runtimeApi = fixedApi(job);
    const runtimeWrapper = mountOwner('A', runtimeApi, true);
    await flushPromises();
    const runtimeSnapshot = JSON.stringify({
      bundle: currentScope().$source.bundle,
      draft: currentScope().jobDraft,
    });
    expect(runtimeApi.jobs.get).toHaveBeenCalledTimes(1);
    expect(currentScope().$loading.loadDirect).toBeUndefined();
    expect(runtimeSnapshot).toBe(directSnapshot);
    expect(runtimeApi.jobs.patch).not.toHaveBeenCalled();
    runtimeWrapper.unmount();
  });

  it.each([true, false])('Job Memory v2 在 Runtime=%s 时只读聚合 Bundle', async (runtimeEnabled) => {
    const api = v2Api(makeJob('A'));
    const wrapper = mountOwner('A', api, runtimeEnabled, true);
    await flushPromises();
    expect(api.jobMemory?.getJobDetailBundle).toHaveBeenCalledTimes(1);
    expect(api.jobs.get).not.toHaveBeenCalled();
    expect(api.jobs.list).not.toHaveBeenCalled();
    expect(api.profile.get).not.toHaveBeenCalled();
    expect(currentScope().$source.bundle).toMatchObject({
      jobId: 'A',
      memory: { applications: [] },
    });
    wrapper.unmount();
  });

  it('v1 capability 关闭时严格保留 job/profile/allJobs 三读取且不碰 v2 API', async () => {
    const api = v2Api(makeJob('A'));
    const wrapper = mountOwner('A', api, true, false);
    await flushPromises();
    expect(api.jobs.get).toHaveBeenCalledTimes(1);
    expect(api.jobs.list).toHaveBeenCalledTimes(1);
    expect(api.profile.get).toHaveBeenCalledTimes(1);
    expect(api.jobMemory?.getJobDetailBundle).not.toHaveBeenCalled();
    expect(currentScope().$source.bundle).not.toHaveProperty('memory');
    wrapper.unmount();
  });
});
