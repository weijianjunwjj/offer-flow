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
  options: RouterFeatureOptions = features,
): Router {
  return createRouter({ history, routes: createRoutes(options) });
}

export const router = createOfferFlowRouter();
