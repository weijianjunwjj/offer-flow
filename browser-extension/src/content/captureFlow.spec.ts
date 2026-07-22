import { describe, expect, it, vi } from 'vitest';
import { runCaptureFlow, type AddItemPayload, type CaptureFlowDeps } from './captureFlow';
import type { PageCaptureExecutionResult } from './captureResult';

type AddItemFn = (sessionId: string, payload: AddItemPayload) => Promise<void>;

function makeDeps(overrides: Partial<CaptureFlowDeps> = {}): CaptureFlowDeps {
  return {
    getCaptureResult: vi.fn(async () => ({ ok: false, code: 'SCRIPT_EXECUTION_FAILED', message: 'x' } as PageCaptureExecutionResult)),
    fallbackSourceUrl: vi.fn(() => null),
    createSession: vi.fn(async () => ({ id: 'session-1' })),
    addItem: vi.fn(async () => undefined),
    openPreview: vi.fn(async () => undefined),
    setStatus: vi.fn(),
    isOfflineError: vi.fn(() => false),
    ...overrides,
  };
}

describe('runCaptureFlow', () => {
  it('does NOT call any Capture API when the page result is a failure (§五.9)', async () => {
    const deps = makeDeps({
      getCaptureResult: vi.fn(async () => ({ ok: false, code: 'UNSUPPORTED_PAGE', message: '当前页面不支持采集' } as PageCaptureExecutionResult)),
    });
    await runCaptureFlow(deps);
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.addItem).not.toHaveBeenCalled();
    expect(deps.openPreview).not.toHaveBeenCalled();
    // 展示的是根因对应的安全文案 (§五.11)。
    expect(deps.setStatus).toHaveBeenCalledWith('当前页面不支持采集');
  });

  it('sends captureMethod + a schema-shaped payload on success, then opens preview (§五.10)', async () => {
    const capture = {
      captureMethod: 'boss_current_page' as const,
      sourceUrl: 'https://www.zhipin.com/job_detail/abc.html',
      pageTitle: '后端工程师',
      visibleText: '岗位描述……',
      recognizedFields: {
        company: 'Acme', role: '后端工程师', city: '上海',
        salaryMinK: 20, salaryMaxK: 30, salaryPeriod: 'month',
        experienceRequirement: null, educationRequirement: null,
      },
      extractionMetadata: { kind: 'boss_extraction' },
      providerKey: 'boss_zhipin',
      externalRecordId: 'abc',
      commitBlocked: false,
    };
    const addItem = vi.fn<AddItemFn>(async () => undefined);
    const deps = makeDeps({
      getCaptureResult: vi.fn(async () => ({ ok: true, capture } as PageCaptureExecutionResult)),
      addItem,
    });
    await runCaptureFlow(deps);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledTimes(1);
    const call = addItem.mock.calls[0];
    expect(call).toBeDefined();
    const [sessionId, payload] = call!;
    expect(sessionId).toBe('session-1');
    expect(['boss_current_page', 'generic_visible_text']).toContain(payload.captureMethod);
    expect(payload.captureMethod).toBe('boss_current_page');
    expect(typeof payload.visibleText).toBe('string');
    expect(payload.sourceUrl).toBe(capture.sourceUrl);
    expect(deps.openPreview).toHaveBeenCalledWith('session-1');
  });

  it('falls back to the tab URL when the captured payload has no sourceUrl', async () => {
    const addItem = vi.fn<AddItemFn>(async () => undefined);
    const deps = makeDeps({
      getCaptureResult: vi.fn(async () => ({
        ok: true,
        capture: { captureMethod: 'generic_visible_text', sourceUrl: null, pageTitle: null, visibleText: 'x', recognizedFields: null, extractionMetadata: null },
      } as PageCaptureExecutionResult)),
      fallbackSourceUrl: vi.fn(() => 'https://example.com/current-tab'),
      addItem,
    });
    await runCaptureFlow(deps);
    expect(addItem.mock.calls[0]?.[1].sourceUrl).toBe('https://example.com/current-tab');
  });

  it('shows the OfferFlow-not-running message when the API reports offline', async () => {
    const offline = new Error('offline');
    const deps = makeDeps({
      getCaptureResult: vi.fn(async () => ({
        ok: true,
        capture: { captureMethod: 'generic_visible_text', sourceUrl: null, pageTitle: null, visibleText: 'x', recognizedFields: null, extractionMetadata: null },
      } as PageCaptureExecutionResult)),
      createSession: vi.fn(async () => { throw offline; }),
      isOfflineError: vi.fn((error) => error === offline),
    });
    await runCaptureFlow(deps);
    expect(deps.setStatus).toHaveBeenCalledWith(expect.stringContaining('OfferFlow 未启动'));
    expect(deps.openPreview).not.toHaveBeenCalled();
  });

  it('never leaks page content into the error status text (§五.12)', async () => {
    const secret = '这是完整JD正文和招聘者微信13800000000';
    const deps = makeDeps({
      getCaptureResult: vi.fn(async () => ({ ok: false, code: 'EMPTY_PAGE_CONTENT', message: '当前页面没有可提取的可见文本，请确认页面已加载完成后重试。' } as PageCaptureExecutionResult)),
    });
    await runCaptureFlow(deps);
    const statusCalls = (deps.setStatus as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    for (const text of statusCalls) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain('13800000000');
    }
  });
});
