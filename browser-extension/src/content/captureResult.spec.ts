import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { buildPageCaptureResult, failureMessage, normalizeInjectionResult } from './captureResult';

function parseHtml(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

describe('buildPageCaptureResult', () => {
  it('returns ok with boss_current_page when BOSS detail selectors hit (partial fields kept null, not fabricated)', () => {
    const doc = parseHtml(`
      <html><head><title>后端工程师招聘</title></head><body>
        <h1 class="name job-name">后端工程师</h1>
        <span class="job-area">上海</span>
        <p>岗位职责……</p>
      </body></html>
    `);
    const result = buildPageCaptureResult('https://www.zhipin.com/job_detail/abc.html', doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.captureMethod).toBe('boss_current_page');
    expect(result.capture.recognizedFields?.role).toBe('后端工程师');
    // 未命中的字段保持 null，不编造。
    expect(result.capture.recognizedFields?.company).toBeNull();
    expect(result.capture.sourceUrl).toBe('https://www.zhipin.com/job_detail/abc.html');
  });

  it('falls back to generic_visible_text when all BOSS selectors miss on a zhipin page (§五.5)', () => {
    const doc = parseHtml('<html><head><title>列表</title></head><body><p>页面结构已变化，没有命中任何定向字段</p></body></html>');
    const result = buildPageCaptureResult('https://www.zhipin.com/job_detail/xyz.html', doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.captureMethod).toBe('generic_visible_text');
    expect(result.capture.recognizedFields).toBeNull();
    expect(result.capture.visibleText.length).toBeGreaterThan(0);
  });

  it('list_panel 列表页不静默退回 generic：无右侧详情容器/稳定 ID 时标记为阻塞，不编造字段 (§三/§六)', () => {
    const doc = parseHtml('<html><head><title>求职|找工作|招聘信息-BOSS直聘</title></head><body><ul><li>岗位一</li><li>岗位二</li></ul></body></html>');
    const result = buildPageCaptureResult('https://www.zhipin.com/web/geek/jobs?query=后端', doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // §三：list_panel 不因未命中而退回 generic；仍是 boss_current_page 但不猜字段。
    expect(result.capture.captureMethod).toBe('boss_current_page');
    expect(result.capture.recognizedFields).toBeNull();
    // §六：无稳定岗位 ID → 阻塞确认写入，且不用列表页 pageTitle 解析公司/岗位。
    expect(result.capture.commitBlocked).toBe(true);
    expect(result.capture.externalRecordId).toBeNull();
    // §八：定位失败后绝不把整页岗位列表文本当作 JD 正文；visibleText 为明确标注的诊断摘要（非空）。
    expect(result.capture.visibleText.length).toBeGreaterThan(0);
    expect(result.capture.visibleText).toContain('未采集到岗位 JD 正文');
    expect(result.capture.visibleText).not.toContain('岗位一');
    expect(result.capture.visibleText).not.toContain('岗位二');
  });

  it('returns generic fallback for non-BOSS pages with visible text (§五.8)', () => {
    const doc = parseHtml('<html><head><title>其他招聘</title></head><body><p>其他招聘网站的岗位描述</p></body></html>');
    const result = buildPageCaptureResult('https://example.com/jobs/1', doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capture.captureMethod).toBe('generic_visible_text');
  });

  it('returns EMPTY_PAGE_CONTENT when there is no visible text', () => {
    const doc = parseHtml('<html><body></body></html>');
    const result = buildPageCaptureResult('https://example.com/empty', doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('EMPTY_PAGE_CONTENT');
  });

  it('returns UNSUPPORTED_PAGE when the document has no body (restricted/internal page)', () => {
    const result = buildPageCaptureResult('chrome://settings', { body: null } as unknown as Document);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNSUPPORTED_PAGE');
  });

  it('returns EXTRACTION_FAILED (not a thrown error, not bare null) when extraction throws (§五.4)', () => {
    const doc = {
      body: {},
      querySelector: () => { throw new Error('DOM 崩溃'); },
    } as unknown as Document;
    const result = buildPageCaptureResult('https://www.zhipin.com/job_detail/boom.html', doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('EXTRACTION_FAILED');
    // 不泄露异常细节/页面内容。
    expect(result.message).not.toContain('DOM 崩溃');
  });
});

describe('normalizeInjectionResult', () => {
  it('maps an empty InjectionResult array to SCRIPT_EXECUTION_FAILED (§五.1)', () => {
    const result = normalizeInjectionResult([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCRIPT_EXECUTION_FAILED');
  });

  it('maps a missing results[0] to SCRIPT_EXECUTION_FAILED (§五.2)', () => {
    const result = normalizeInjectionResult([undefined]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCRIPT_EXECUTION_FAILED');
  });

  it('maps results[0].result === null to SCRIPT_EXECUTION_FAILED (§五.3)', () => {
    const result = normalizeInjectionResult([{ result: null }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SCRIPT_EXECUTION_FAILED');
  });

  it('maps a non-object / shapeless result to SCRIPT_EXECUTION_FAILED', () => {
    expect(normalizeInjectionResult('not-an-array').ok).toBe(false);
    expect(normalizeInjectionResult([{ result: { noOkFlag: true } }]).ok).toBe(false);
  });

  it('passes through a valid discriminated-union result', () => {
    const payload = { ok: true, capture: { captureMethod: 'generic_visible_text', sourceUrl: null, pageTitle: null, visibleText: 'x', recognizedFields: null } };
    const result = normalizeInjectionResult([{ result: payload }]);
    expect(result.ok).toBe(true);
  });
});

describe('failure messages (§五.12)', () => {
  it('never expose capability/session/token/full page content', () => {
    for (const code of ['UNSUPPORTED_PAGE', 'EXTRACTION_FAILED', 'EMPTY_PAGE_CONTENT', 'SCRIPT_EXECUTION_FAILED'] as const) {
      const message = failureMessage(code);
      expect(message.length).toBeGreaterThan(0);
      expect(message.toLowerCase()).not.toContain('capability');
      expect(message.toLowerCase()).not.toContain('token');
      expect(message.toLowerCase()).not.toContain('sessionid');
      expect(message.toLowerCase()).not.toContain('cookie');
    }
  });
});
