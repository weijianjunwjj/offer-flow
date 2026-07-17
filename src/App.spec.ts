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
