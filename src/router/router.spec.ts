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

  it('注册岗位匹配画像一级路由', async () => {
    const router = createOfferFlowRouter(createMemoryHistory());
    await router.push('/job-match-profile');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('job-match-profile');
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

  it('基础漏斗路由默认注册（只读，无需 schema 迁移）', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
    });
    await router.push('/market-funnel');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('market-funnel');
  });

  it('历史补录默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      historyImportEnabled: false,
    });
    await router.push('/history-import');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('history-import-disabled');
  });

  it('显式开启时注册 /history-import', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      historyImportEnabled: true,
    });
    await router.push('/history-import');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('history-import');
  });

  it('市场位置画像（G4）默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      marketPositionEnabled: false,
    });
    await router.push('/market-position');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('market-position-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/market-position');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启时注册 /market-position（仅 G4 沙箱环境）', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      marketPositionEnabled: true,
    });
    await router.push('/market-position');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('market-position');
  });

  it('求职策略（G5）默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      strategyWindowEnabled: false,
    });
    await router.push('/strategy-window');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('strategy-window-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/strategy-window');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启时注册 /strategy-window（仅 G5 沙箱环境）', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      strategyWindowEnabled: true,
    });
    await router.push('/strategy-window');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('strategy-window');
  });

  it('岗位雷达人工评审（V8-3）默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      radarEnabled: false,
    });
    await router.push('/radar/review');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('radar-review-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/radar/review');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启 radar 时注册 /radar/review（仅 V8-3 沙箱环境）', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      radarEnabled: true,
    });
    await router.push('/radar/review');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('radar-review');
  });

  it('每日求职计划（T023）默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      dailySearchPlanEnabled: false,
    });
    await router.push('/daily-search-plans');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('daily-search-plans-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/daily-search-plans');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启时注册 /daily-search-plans', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      dailySearchPlanEnabled: true,
    });
    await router.push('/daily-search-plans');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('daily-search-plans');
  });

  it('每日求职简报（T042）默认关闭时深链接安全重定向到岗位台账', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      dailySearchPlanEnabled: false,
    });
    await router.push('/daily-job-briefs');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('jobs');
    expect(router.currentRoute.value.query.feature).toBe('daily-job-briefs-disabled');
    const disabledRecord = router.getRoutes().find((route) => route.path === '/daily-job-briefs');
    expect(disabledRecord?.components).toBeUndefined();
    expect(disabledRecord?.redirect).toBeDefined();
  });

  it('显式开启时注册 /daily-job-briefs', async () => {
    const router = createOfferFlowRouter(createMemoryHistory(), {
      jobMemoryV2Enabled: true,
      dailySearchPlanEnabled: true,
    });
    await router.push('/daily-job-briefs');
    await router.isReady();
    expect(router.currentRoute.value.name).toBe('daily-job-briefs');
  });
});
