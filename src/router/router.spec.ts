import { createMemoryHistory } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { createOfferFlowRouter, normalizeJobId } from './index';

describe('OfferFlow Router', () => {
  it('使用岗位列表作为根路由并支持前进后退', async () => {
    const router = createOfferFlowRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');

    await router.push('/profile');
    await router.push('/jobs/job-A');
    expect(router.currentRoute.value.params.jobId).toBe('job-A');
    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.name).toBe('profile');
  });

  it('保留合法的非 UUID 岗位 ID，并拒绝空值和超长值', () => {
    expect(normalizeJobId(' jd_import_2026 ')).toBe('jd_import_2026');
    expect(normalizeJobId('')).toBeNull();
    expect(normalizeJobId('x'.repeat(201))).toBeNull();
  });

  it('未知前端路径进入 NotFoundPage', async () => {
    const router = createOfferFlowRouter(createMemoryHistory());
    await router.push('/missing/path');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('not-found');
  });

  it('默认关闭时深链接安全重定向到 Profile，不加载 B3 页面', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: false,
    });
    await router.push('/profile-versions');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('profile');
    expect(router.currentRoute.value.query.feature).toBe('resume-versions-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/profile-versions');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启时注册 /profile-versions，前进后退保持原路由语义', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
    });
    await router.push('/profile');
    await router.isReady();
    await router.push('/profile-versions');
    expect(router.currentRoute.value.name).toBe('profile-versions');
    router.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.currentRoute.value.name).toBe('profile');
  });
});
