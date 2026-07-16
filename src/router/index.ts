import {
  createRouter,
  createWebHashHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router';
import ProfileConfigPage from '../pages/ProfileConfigPage.vue';
import JobMatchProfilePage from '../pages/JobMatchProfilePage.vue';
import CapabilityBaselinePage from '../pages/CapabilityBaselinePage.vue';
import HistoryImportPage from '../pages/HistoryImportPage.vue';
import MarketFunnelPage from '../pages/MarketFunnelPage.vue';
import MarketPositionPage from '../pages/MarketPositionPage.vue';
import StrategyWindowPage from '../pages/StrategyWindowPage.vue';
import JobListPage from '../pages/JobListPage.vue';
import JobCreatePage from '../pages/JobCreatePage.vue';
import JobDetailPage from '../pages/JobDetailPage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';
import { features } from '../config/features';

export const MAX_JOB_ID_LENGTH = 200;

export function normalizeJobId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized !== '' && normalized.length <= MAX_JOB_ID_LENGTH ? normalized : null;
}

export interface RouterFeatureOptions {
  jobMemoryV2Enabled: boolean;
  historyImportEnabled?: boolean;
  marketPositionEnabled?: boolean;
  strategyWindowEnabled?: boolean;
}

export function createRoutes(options: RouterFeatureOptions): RouteRecordRaw[] {
  return [
    { path: '/', redirect: { name: 'jobs' } },
    { path: '/profile', name: 'profile', component: ProfileConfigPage },
    { path: '/job-match-profile', name: 'job-match-profile', component: JobMatchProfilePage },
    { path: '/capability-baseline', name: 'capability-baseline', component: CapabilityBaselinePage },
    { path: '/market-funnel', name: 'market-funnel', component: MarketFunnelPage },
    options.historyImportEnabled
      ? { path: '/history-import', name: 'history-import', component: HistoryImportPage }
      : {
        path: '/history-import',
        name: 'history-import-disabled',
        redirect: { name: 'jobs', query: { feature: 'history-import-disabled' } },
      },
    options.marketPositionEnabled
      ? { path: '/market-position', name: 'market-position', component: MarketPositionPage }
      : {
        path: '/market-position',
        name: 'market-position-disabled',
        redirect: { name: 'jobs', query: { feature: 'market-position-disabled' } },
      },
    options.strategyWindowEnabled
      ? { path: '/strategy-window', name: 'strategy-window', component: StrategyWindowPage }
      : {
        path: '/strategy-window',
        name: 'strategy-window-disabled',
        redirect: { name: 'jobs', query: { feature: 'strategy-window-disabled' } },
      },
    options.jobMemoryV2Enabled
      ? {
        path: '/profile-versions',
        name: 'profile-versions',
        component: () => import('../pages/ResumeVersionsPage.vue'),
      }
      : {
        path: '/profile-versions',
        name: 'profile-versions-disabled',
        redirect: { name: 'profile', query: { feature: 'resume-versions-disabled' } },
      },
    { path: '/jobs', name: 'jobs', component: JobListPage },
    { path: '/jobs/new', name: 'job-new', component: JobCreatePage },
    {
      path: '/jobs/:jobId',
      name: 'job-detail',
      component: JobDetailPage,
      props: (route) => ({ jobId: normalizeJobId(route.params.jobId) }),
    },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundPage },
  ];
}

export function createOfferFlowRouter(
  history: RouterHistory = createWebHashHistory(),
  options: RouterFeatureOptions = {
    jobMemoryV2Enabled: features.jobMemoryV2Enabled,
    historyImportEnabled: features.historyImportEnabled,
    marketPositionEnabled: features.g4SandboxEnabled || features.g6RehearsalEnabled,
    strategyWindowEnabled: features.g5SandboxEnabled || features.g6RehearsalEnabled,
  },
): Router {
  return createRouter({ history, routes: createRoutes(options) });
}

export const router = createOfferFlowRouter();
