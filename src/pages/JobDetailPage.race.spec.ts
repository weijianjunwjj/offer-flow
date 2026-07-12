import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { scopeRegistry } from 'vue-page-scope';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import JobDetailPage from './JobDetailPage.vue';

interface PendingRead {
  jobId: string;
  signal: AbortSignal | undefined;
  resolve(job: JobRecord): void;
  reject(error: unknown): void;
}

const apiMocks = vi.hoisted(() => ({
  pending: [] as PendingRead[],
  respectAbort: true,
  patch: vi.fn(),
}));

vi.mock('../api/jobsApi', () => ({
  jobsApi: {
    get(jobId: string, options?: { signal?: AbortSignal }) {
      return new Promise<JobRecord>((resolve, reject) => {
        const pending = { jobId, signal: options?.signal, resolve, reject };
        apiMocks.pending.push(pending);
        if (apiMocks.respectAbort) {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        }
      });
    },
    list: vi.fn().mockResolvedValue([]),
    patch: apiMocks.patch,
  },
}));

vi.mock('../api/profileApi', () => ({
  profileApi: { get: vi.fn().mockResolvedValue(null) },
}));

vi.mock('./BattlefieldPage.vue', async () => {
  const { injectJobDetailScope } = await import('../page-scopes/jobDetailScope');
  return {
    default: defineComponent({
      setup() {
        const scope = injectJobDetailScope();
        return () => h('p', { 'data-current-job': '' }, scope?.$source.bundle?.job.id ?? 'empty');
      },
    }),
  };
});

function makeJob(id: string): JobRecord {
  return {
    id, createdAt: 1, updatedAt: 1, company: id, role: id, city: '苏州', salaryRange: '', jdText: '',
    promptText: '', aiRawResult: '', aiPastedAt: null, parseStatus: 'none', report: null,
    matchScore: '', companyInput: emptyCompanyInput(), companyAssessment: null,
    opportunityAnalysis: null, communicationStatus: 'not_contacted', followupCount: 0,
  };
}

async function runRace(respectAbort: boolean): Promise<void> {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  apiMocks.respectAbort = respectAbort;
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/jobs', component: { render: () => h('p', 'list') } },
      { path: '/jobs/:jobId', component: JobDetailPage, props: true },
    ],
  });
  const Host = defineComponent({
    setup() {
      return () => h(RouterView, null, {
        default: ({ Component, route }: { Component: unknown; route: { params: { jobId?: string } } }) =>
          h(Component as never, { key: route.params.jobId ?? 'list' }),
      });
    },
  });
  await router.push('/jobs/A');
  await router.isReady();
  const wrapper = mount(Host, { global: { plugins: [router] } });
  await flushPromises();
  await router.push('/jobs/B');
  await flushPromises();
  await router.push('/jobs/C');
  await flushPromises();

  const reads = Object.fromEntries(apiMocks.pending.map((read) => [read.jobId, read]));
  expect(reads.A?.signal?.aborted).toBe(true);
  expect(reads.B?.signal?.aborted).toBe(true);
  reads.C?.resolve(makeJob('C'));
  await flushPromises();
  reads.B?.resolve(makeJob('B'));
  reads.A?.resolve(makeJob('A'));
  await flushPromises();

  expect(wrapper.get('[data-current-job]').text()).toBe('C');
  expect(scopeRegistry.size).toBe(1);
  expect(scopeRegistry.get('job-detail')?.$source.bundle.job.id).toBe('C');
  expect(scopeRegistry.get('job-detail')?.$loading.loadJobBundle).toBe(false);
  expect(apiMocks.patch).not.toHaveBeenCalled();
  expect(errorSpy).not.toHaveBeenCalled();

  await router.push('/jobs');
  await flushPromises();
  expect(scopeRegistry.size).toBe(0);
  wrapper.unmount();
  errorSpy.mockRestore();
}

beforeEach(() => {
  apiMocks.pending.length = 0;
  apiMocks.patch.mockReset();
});

afterEach(() => {
  scopeRegistry.get('job-detail')?.$destroy();
});

describe('JobDetailPage A→B→C 竞态', () => {
  it('底层请求尊重 abort 时只提交 C', async () => {
    await runRace(true);
  });

  it('底层请求忽略 abort 且迟到返回时仍只提交 C', async () => {
    await runRace(false);
  });
});
