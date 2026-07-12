import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

describe('Vue 组件测试基础', () => {
  it('可以挂载组件、响应交互并使用 fake timers', async () => {
    vi.useFakeTimers();
    const Component = defineComponent({
      setup() {
        const count = ref(0);
        setTimeout(() => {
          count.value += 1;
        }, 10);
        return () => h('button', { onClick: () => count.value += 1 }, String(count.value));
      },
    });

    const wrapper = mount(Component);
    expect(wrapper.text()).toBe('0');
    await wrapper.trigger('click');
    expect(wrapper.text()).toBe('1');
    await vi.advanceTimersByTimeAsync(10);
    expect(wrapper.text()).toBe('2');
    wrapper.unmount();
    vi.useRealTimers();
  });

  it('运行环境提供 fetch 与 AbortController', () => {
    expect(typeof fetch).toBe('function');
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
