import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import App from './App.vue';

describe('App B3 默认导航门禁', () => {
  it('默认 flag=false 时不显示简历版本导航入口', async () => {
    const EmptyPage = defineComponent({ render: () => h('p', 'page') });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/profile');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').map((button) => button.text())).toContain('简历配置');
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('简历版本');
    wrapper.unmount();
  });

  it('路由由显式 flag 注册后显示唯一简历版本入口', async () => {
    const EmptyPage = defineComponent({ render: () => h('p', 'page') });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/profile-versions', name: 'profile-versions', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/profile');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').filter((button) => button.text() === '简历版本')).toHaveLength(1);
    await wrapper.findAll('button').find((button) => button.text() === '简历版本')?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('profile-versions');
    wrapper.unmount();
  });
});

describe('App 岗位雷达主线入口门禁', () => {
  const EmptyPage = defineComponent({ render: () => h('p', 'page') });

  it('radar 路由未注册时不显示「岗位雷达」入口', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('岗位雷达');
    wrapper.unmount();
  });

  it('radar 路由注册后显示唯一入口，点击跳转采集页', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/radar/import', name: 'radar-import', component: EmptyPage },
        { path: '/radar/review', name: 'radar-review', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').filter((b) => b.text() === '岗位雷达')).toHaveLength(1);
    await wrapper.findAll('button').find((b) => b.text() === '岗位雷达')?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('radar-import');
    wrapper.unmount();
  });

  it('停留在 radar 页面时「岗位雷达」入口高亮（primary + ghost）', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/radar/import', name: 'radar-import', component: EmptyPage },
        { path: '/radar/review', name: 'radar-review', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/radar/review');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    const radarBtn = wrapper.find('[data-testid="nav-radar"]');
    expect(radarBtn.exists()).toBe(true);
    expect(radarBtn.classes().join(' ')).toContain('n-button--primary-type');
    wrapper.unmount();
  });
});

describe('App 每日求职计划入口门禁', () => {
  const EmptyPage = defineComponent({ render: () => h('p', 'page') });

  it('daily-search-plans 路由未注册时不显示「每日求职计划」入口', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('每日求职计划');
    wrapper.unmount();
  });

  it('路由注册后显示唯一入口，点击跳转配置页', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/daily-search-plans', name: 'daily-search-plans', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').filter((button) => button.text() === '每日求职计划')).toHaveLength(1);
    await wrapper.findAll('button').find((button) => button.text() === '每日求职计划')?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('daily-search-plans');
    wrapper.unmount();
  });

  it('停留在每日求职计划页面时入口高亮（primary + ghost）', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/daily-search-plans', name: 'daily-search-plans', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/daily-search-plans');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    const navBtn = wrapper.find('[data-testid="nav-daily-search-plans"]');
    expect(navBtn.exists()).toBe(true);
    expect(navBtn.classes().join(' ')).toContain('n-button--primary-type');
    wrapper.unmount();
  });
});

describe('App 每日求职简报入口门禁', () => {
  const EmptyPage = defineComponent({ render: () => h('p', 'page') });

  it('daily-job-briefs 路由未注册时不显示「每日求职简报」入口', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('每日求职简报');
    wrapper.unmount();
  });

  it('路由注册后显示唯一入口，点击跳转简报页', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/profile', name: 'profile', component: EmptyPage },
        { path: '/daily-job-briefs', name: 'daily-job-briefs', component: EmptyPage },
        { path: '/jobs', name: 'jobs', component: EmptyPage },
      ],
    });
    await router.push('/jobs');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [router] } });
    expect(wrapper.findAll('button').filter((button) => button.text() === '每日求职简报')).toHaveLength(1);
    await wrapper.findAll('button').find((button) => button.text() === '每日求职简报')?.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('daily-job-briefs');
    wrapper.unmount();
  });
});
