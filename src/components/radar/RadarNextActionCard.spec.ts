/**
 * 单一主行动卡测试。
 *
 * 重点：每页只呈现一个主 CTA；无 cta 时降级为纯引导（不渲染按钮）；
 * 点击只 emit('act')，禁用态不可点。
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import RadarNextActionCard from './RadarNextActionCard.vue';

describe('RadarNextActionCard', () => {
  it('有 cta 时渲染主按钮并可点击 emit act', async () => {
    const w = mount(RadarNextActionCard, {
      props: { title: '去审核岗位', hint: '登记重复与变化', cta: '去审核岗位' },
    });
    expect(w.find('[data-testid="radar-next-action-title"]').text()).toContain('去审核岗位');
    expect(w.find('[data-testid="radar-next-action-hint"]').text()).toContain('登记重复与变化');
    const cta = w.find('[data-testid="radar-next-action-cta"]');
    expect(cta.exists()).toBe(true);
    await cta.trigger('click');
    expect(w.emitted('act')).toHaveLength(1);
  });

  it('无 cta 时降级为纯引导（不渲染按钮）', () => {
    const w = mount(RadarNextActionCard, { props: { title: '请先选择一组岗位' } });
    expect(w.find('[data-testid="radar-next-action-cta"]').exists()).toBe(false);
    expect(w.find('[data-testid="radar-next-action-hint"]').exists()).toBe(false);
  });

  it('禁用态按钮不可点', async () => {
    const w = mount(RadarNextActionCard, {
      props: { title: '待条件满足', cta: '继续', disabled: true },
    });
    const cta = w.find('[data-testid="radar-next-action-cta"]');
    expect(cta.attributes('disabled')).toBeDefined();
  });
});
