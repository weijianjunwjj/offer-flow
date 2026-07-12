import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BattlefieldPage from './BattlefieldPage.vue';

const ocrMock = vi.fn<() => Promise<string>>();
vi.mock('../ocr/jdImageOcr', () => ({ performJdImageOcr: () => ocrMock() }));
vi.mock('../api/profileApi', () => ({ profileApi: { get: vi.fn().mockResolvedValue(null) } }));
vi.mock('../api/jobsApi', () => ({
  jobsApi: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(), create: vi.fn(), patch: vi.fn(),
  },
}));

function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }],
  });
  return mount(BattlefieldPage, { props: { jobId: null }, global: { plugins: [router] } });
}

function pasteImage(wrapper: ReturnType<typeof mountPage>): void {
  const file = new File(['image'], 'jd.png', { type: 'image/png' });
  const textarea = wrapper.get('textarea[placeholder*="JD 截图"]');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
  });
  textarea.element.dispatchEvent(event);
}

beforeEach(() => {
  ocrMock.mockReset();
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn().mockReturnValue('blob:jd'),
    revokeObjectURL: vi.fn(),
  });
});

describe('JD OCR 生命周期', () => {
  it('删除图片会立即释放 object URL', async () => {
    const wrapper = mountPage();
    pasteImage(wrapper);
    await wrapper.vm.$nextTick();
    await wrapper.get('.jd-image-remove').trigger('click');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:jd');
    wrapper.unmount();
  });

  it('unmount 后迟到 OCR 不再写页面，并释放全部 object URL', async () => {
    let resolveOcr!: (value: string) => void;
    ocrMock.mockReturnValue(new Promise((resolve) => { resolveOcr = resolve; }));
    const wrapper = mountPage();
    pasteImage(wrapper);
    await wrapper.vm.$nextTick();
    await wrapper.get('.jd-convert-btn').trigger('click');
    wrapper.unmount();
    resolveOcr('迟到的 OCR 文本');
    await flushPromises();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:jd');
  });
});
