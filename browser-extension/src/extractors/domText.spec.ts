import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { extractCleanText, isHiddenElement, stripInlineNoise, type StyleProbeWindow } from './domText';

function parse(html: string): Document {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
}

describe('domText.extractCleanText (§七 反爬文本清洗)', () => {
  it('12. <style> 规则文本不进入可见文本', () => {
    const doc = parse(
      '<html><body><div id="c"><style>.FrYhQzfSwwjF{display:inline-block;font-size:0!important;visibility:hidden;}</style>正文内容</div></body></html>',
    );
    const text = extractCleanText(doc.querySelector('#c'));
    expect(text).toBe('正文内容');
    expect(text).not.toContain('FrYhQzfSwwjF');
    expect(text).not.toContain('font-size');
  });

  it('13. display:none / visibility:hidden / font-size:0 干扰节点被删除', () => {
    const doc = parse(
      '<html><body><div id="c">前<span style="display:none">A</span>中<span style="visibility:hidden">B</span>后<span style="font-size:0">C</span>尾</div></body></html>',
    );
    expect(extractCleanText(doc.querySelector('#c'))).toBe('前中后尾');
  });

  it('14. 被插入词语中间的隐藏 kanzhun / BOSS直聘 被还原为合理正文', () => {
    const doc = parse(
      '<html><body><div id="c">高级前<span style="visibility:hidden">kanzhun</span>端工程<span style="display:none">BOSS直聘</span>师</div></body></html>',
    );
    expect(extractCleanText(doc.querySelector('#c'))).toBe('高级前端工程师');
  });

  it('stripInlineNoise 去独立 kanzhun 并还原中文词中间插入的 BOSS直聘', () => {
    expect(stripInlineNoise('高级前kanzhun端工程BOSS直聘师')).toBe('高级前端工程师');
    // 两侧带空白的正常 BOSS直聘 提及保留。
    expect(stripInlineNoise('来源 BOSS直聘 平台')).toContain('BOSS直聘');
  });

  it('isHiddenElement 命中内联隐藏样式', () => {
    const doc = parse('<html><body><span id="h" style="font-size:0!important">x</span><span id="v">y</span></body></html>');
    const win = doc.defaultView as unknown as StyleProbeWindow;
    expect(isHiddenElement(doc.querySelector('#h')!, win)).toBe(true);
    expect(isHiddenElement(doc.querySelector('#v')!, win)).toBe(false);
  });

  it('不破坏正常编号/标点/HTML5/CSS3/BOSS 等真实岗位内容', () => {
    const doc = parse(
      '<html><body><div id="c">1. 熟悉 HTML5、CSS3；2. 了解 BOSS 业务。</div></body></html>',
    );
    const text = extractCleanText(doc.querySelector('#c'));
    expect(text).toContain('HTML5');
    expect(text).toContain('CSS3');
    expect(text).toContain('BOSS');
    expect(text).toContain('1.');
    expect(text).toContain('；');
  });
});
