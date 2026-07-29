/**
 * 岗位雷达三阶段步骤条测试。
 *
 * 重点：纯展示 + 事件——高亮当前阶段、已完成阶段前置、点击只 emit('navigate')
 * 而不自行路由（保证组件可无 router 单测、由页面掌控跳转）。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RadarStageStepper from './RadarStageStepper.vue';

function render(current: 'collect' | 'review' | 'promote') {
  return mount(RadarStageStepper, { props: { current } });
}

describe('RadarStageStepper', () => {
  it('渲染三阶段并高亮当前阶段', () => {
    const w = render('review');
    expect(w.find('[data-testid="radar-stage-stepper"]').exists()).toBe(true);
    expect(w.find('[data-testid="radar-stage-collect"]').exists()).toBe(true);
    expect(w.find('[data-testid="radar-stage-review"]').exists()).toBe(true);
    expect(w.find('[data-testid="radar-stage-promote"]').exists()).toBe(true);
    const active = w.find('[data-testid="radar-stage-review"]');
    expect(active.classes()).toContain('is-active');
    expect(active.attributes('aria-current')).toBe('step');
  });

  it('当前阶段之前为已完成、之后为待办', () => {
    const w = render('review');
    expect(w.find('[data-testid="radar-stage-collect"]').classes()).toContain('is-done');
    expect(w.find('[data-testid="radar-stage-promote"]').classes()).toContain('is-todo');
  });

  it('点击某阶段 emit navigate 且不自行跳转', async () => {
    const w = render('collect');
    await w.find('[data-testid="radar-stage-promote"]').trigger('click');
    expect(w.emitted('navigate')?.[0]).toEqual(['promote']);
  });
});
