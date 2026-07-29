/**
 * RC-10 第二波 · 雷达动作栏组件测试。
 *
 * 重点：四族状态如实渲染（set 按钮 vs 生效态+撤销入口）；一键 toggle 调用正确 API；
 * 刷新（重挂载）后按服务端状态恢复；候选切换重新拉取；changed 才上抛 changed 事件（幂等不打扰）；
 * 无任何自动晋升（组件绝不触碰 promotion API）。
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateActionView } from '../../api/radarActionApi';
import RadarActionBar from './RadarActionBar.vue';

const mocks = vi.hoisted(() => ({ getView: vi.fn(), apply: vi.fn(), revert: vi.fn() }));
vi.mock('../../api/radarActionApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarActionApi')>();
  return { ...actual, radarActionApi: mocks };
});

function view(over: Partial<CandidateActionView> = {}): CandidateActionView {
  return {
    candidateId: 'cand-1', activeCandidateVersionId: 'cv-1',
    state: { saved: false, ignored: false, priority: false, appliedPending: false },
    history: [], ...over,
  };
}

function render(candidateId = 'cand-1') {
  return mount(RadarActionBar, { props: { candidateId } });
}

beforeEach(() => {
  mocks.getView.mockReset();
  mocks.apply.mockReset();
  mocks.revert.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('动作栏 · 四族状态渲染', () => {
  it('挂载即拉取状态；未生效族显示 set 按钮', async () => {
    mocks.getView.mockResolvedValue(view());
    const w = render();
    await flushPromises();
    expect(mocks.getView).toHaveBeenCalledWith('cand-1');
    for (const f of ['save', 'ignore', 'priority', 'appliedPending']) {
      expect(w.find(`[data-testid="action-set-${f}"]`).exists()).toBe(true);
      expect(w.find(`[data-testid="action-active-${f}"]`).exists()).toBe(false);
    }
  });

  it('已生效族显示状态标签 + 撤销入口，不再显示 set 按钮', async () => {
    mocks.getView.mockResolvedValue(view({ state: { saved: true, ignored: true, priority: false, appliedPending: false } }));
    const w = render();
    await flushPromises();
    expect(w.find('[data-testid="action-active-save"]').exists()).toBe(true);
    expect(w.find('[data-testid="action-revert-save"]').exists()).toBe(true);
    expect(w.find('[data-testid="action-set-save"]').exists()).toBe(false);
    expect(w.find('[data-testid="action-active-ignore"]').exists()).toBe(true);
    // priority 未生效仍是 set 按钮。
    expect(w.find('[data-testid="action-set-priority"]').exists()).toBe(true);
  });
});

describe('动作栏 · toggle 调用正确 API 且上抛 changed', () => {
  it('点未生效族 → apply(family)，changed 时 emit changed', async () => {
    mocks.getView.mockResolvedValue(view());
    mocks.apply.mockResolvedValue({ changed: true, view: view({ state: { saved: true, ignored: false, priority: false, appliedPending: false } }) });
    const w = render();
    await flushPromises();
    await w.find('[data-testid="action-set-save"]').trigger('click');
    await flushPromises();
    expect(mocks.apply).toHaveBeenCalledWith({ candidateId: 'cand-1', family: 'save' });
    expect(mocks.revert).not.toHaveBeenCalled();
    expect(w.emitted('changed')).toEqual([['cand-1']]);
    // 状态刷新为已收藏。
    expect(w.find('[data-testid="action-active-save"]').exists()).toBe(true);
  });

  it('点已生效族的撤销入口 → revert(family)', async () => {
    mocks.getView.mockResolvedValue(view({ state: { saved: false, ignored: true, priority: false, appliedPending: false } }));
    mocks.revert.mockResolvedValue({ changed: true, view: view() });
    const w = render();
    await flushPromises();
    await w.find('[data-testid="action-revert-ignore"]').trigger('click');
    await flushPromises();
    expect(mocks.revert).toHaveBeenCalledWith({ candidateId: 'cand-1', family: 'ignore' });
    expect(w.emitted('changed')).toEqual([['cand-1']]);
  });

  it('幂等 no-op（changed=false）不上抛 changed', async () => {
    mocks.getView.mockResolvedValue(view());
    mocks.apply.mockResolvedValue({ changed: false, view: view() });
    const w = render();
    await flushPromises();
    await w.find('[data-testid="action-set-priority"]').trigger('click');
    await flushPromises();
    expect(w.emitted('changed')).toBeUndefined();
  });
});

describe('动作栏 · 刷新恢复与候选切换', () => {
  it('重挂载（刷新）按服务端状态恢复，不依赖本地缓存', async () => {
    mocks.getView.mockResolvedValue(view({ state: { saved: true, ignored: false, priority: false, appliedPending: false } }));
    const first = render();
    await flushPromises();
    expect(first.find('[data-testid="action-active-save"]').exists()).toBe(true);
    first.unmount();
    // 新实例（模拟刷新）：再次从服务端拉取即恢复同一状态。
    const second = render();
    await flushPromises();
    expect(second.find('[data-testid="action-active-save"]').exists()).toBe(true);
    expect(mocks.getView).toHaveBeenCalledTimes(2);
  });

  it('candidateId 变化 → 以新候选重新拉取', async () => {
    mocks.getView.mockResolvedValue(view());
    const w = render('cand-1');
    await flushPromises();
    await w.setProps({ candidateId: 'cand-2' });
    await flushPromises();
    expect(mocks.getView).toHaveBeenLastCalledWith('cand-2');
  });
});
