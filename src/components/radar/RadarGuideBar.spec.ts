/**
 * 页面三问引导条测试。
 *
 * 重点：固定回答"这是做什么 / 现在做什么 / 完成后去哪"，纯展示传入文案。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RadarGuideBar from './RadarGuideBar.vue';

describe('RadarGuideBar', () => {
  it('渲染三问及对应文案', () => {
    const w = mount(RadarGuideBar, {
      props: { what: '收集岗位', now: '核对并确认写入', next: '去审核处理' },
    });
    expect(w.find('[data-testid="radar-guide-bar"]').exists()).toBe(true);
    expect(w.find('[data-testid="radar-guide-what"]').text()).toContain('收集岗位');
    expect(w.find('[data-testid="radar-guide-now"]').text()).toContain('核对并确认写入');
    expect(w.find('[data-testid="radar-guide-next"]').text()).toContain('去审核处理');
  });
});
