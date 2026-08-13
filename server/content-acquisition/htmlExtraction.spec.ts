/**
 * v0.9 Phase 4C-2 — htmlExtraction 测试（node-html-parser 有界提取）。
 */
import { describe, expect, it } from 'vitest';
import { extractContent } from './htmlExtraction';

describe('extractContent', () => {
  it('提取 title / canonical / plainText', () => {
    const html = [
      '<html><head>',
      '<title>Senior Engineer</title>',
      '<link rel="canonical" href="https://jobs.example.com/senior">',
      '</head><body>',
      '<h1>Senior Engineer</h1>',
      '<p>We are hiring.</p>',
      '</body></html>',
    ].join('');
    const c = extractContent(html, 'text/html');
    expect(c.title).toBe('Senior Engineer');
    expect(c.canonicalUrl).toBe('https://jobs.example.com/senior');
    expect(c.plainText).toBe('Senior Engineer We are hiring.');
    expect(c.contentType).toBe('text/html');
  });

  it('剥离 script / style / noscript / template', () => {
    const html = [
      '<html><head><style>.a{color:red}</style><script>var x=1;</script></head>',
      '<body><template>hidden</template><noscript>noscript text</noscript>',
      '<p>visible</p></body></html>',
    ].join('');
    const c = extractContent(html, null);
    expect(c.plainText).not.toContain('var x');
    expect(c.plainText).not.toContain('color:red');
    expect(c.plainText).not.toContain('hidden');
    expect(c.plainText).not.toContain('noscript text');
    expect(c.plainText).toContain('visible');
  });

  it('whitespace normalization', () => {
    const c = extractContent('<html><body><p>a    b\n\n c</p></body></html>', null);
    expect(c.plainText).toBe('a b c');
  });

  it('entity decoding', () => {
    const c = extractContent('<html><body><p>Tom &amp; Jerry &lt;3</p></body></html>', null);
    expect(c.plainText).toBe('Tom & Jerry <3');
  });

  it('空 HTML → 空字段', () => {
    const c = extractContent('', null);
    expect(c).toEqual({ title: '', plainText: '', canonicalUrl: null, contentType: null });
  });

  it('无 title → 空字符串；无 canonical → null', () => {
    const c = extractContent('<html><body><p>text</p></body></html>', 'text/html');
    expect(c.title).toBe('');
    expect(c.canonicalUrl).toBeNull();
  });

  it('malformed HTML 容错', () => {
    const c = extractContent('<p>unclosed <b>bold<p>next', null);
    expect(c.plainText).toContain('unclosed');
    expect(c.plainText).toContain('bold');
  });
});
