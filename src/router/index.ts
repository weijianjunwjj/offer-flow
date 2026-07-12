import {
  createRouter,
  createWebHashHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router';
import ProfileConfigPage from '../pages/ProfileConfigPage.vue';
import JobListPage from '../pages/JobListPage.vue';
import JobCreatePage from '../pages/JobCreatePage.vue';
import JobDetailPage from '../pages/JobDetailPage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';

export const MAX_JOB_ID_LENGTH = 200;

export function normalizeJobId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized !== '' && normalized.length <= MAX_JOB_ID_LENGTH ? normalized : null;
}

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: { name: 'jobs' } },
  { path: '/profile', name: 'profile', component: ProfileConfigPage },
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

export function createOfferFlowRouter(history: RouterHistory = createWebHashHistory()): Router {
  return createRouter({ history, routes });
}

export const router = createOfferFlowRouter();
