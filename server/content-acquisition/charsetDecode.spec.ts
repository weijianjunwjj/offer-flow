/**
 * v0.9 Phase 4C-2 — charsetDecode 测试。
 *
 * 覆盖：BOM 优先 / Content-Type charset / meta prescan / UTF-8 默认 /
 * unsupported charset / fatal decode failure。
 */
import { describe, expect, it } from 'vitest';
import { decodeContentText } from './charsetDecode';

describe('decodeContentText — UTF-8 默认', () => {
  it('无任何提示 → UTF-8', () => {
    const r = decodeContentText(Buffer.from('hello 世界', 'utf8'), null);
    expect(r).toEqual({ kind: 'ok', text: 'hello 世界' });
  });
});

describe('decodeContentText — BOM 优先', () => {
  it('UTF-8 BOM 被剥离', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello', 'utf8')]);
    const r = decodeContentText(bytes, null);
    expect(r).toEqual({ kind: 'ok', text: 'hello' });
  });

  it('UTF-16LE BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
    const r = decodeContentText(bytes, null);
    expect(r).toEqual({ kind: 'ok', text: 'hi' });
  });
});

describe('decodeContentText — Content-Type charset', () => {
  it('windows-1252', () => {
    // 0xE9 = é（latin-1）
    const r = decodeContentText(Buffer.from([0x48, 0x69, 0x20, 0xe9]), 'text/html; charset=windows-1252');
    expect(r).toEqual({ kind: 'ok', text: 'Hi é' });
  });

  it('charset 参数带引号也能解析', () => {
    const r = decodeContentText(Buffer.from('hi', 'utf8'), 'text/html; charset="utf-8"');
    expect(r).toEqual({ kind: 'ok', text: 'hi' });
  });
});

describe('decodeContentText — meta prescan', () => {
  it('<meta charset> 作为 fallback', () => {
    const html = '<html><head><meta charset="windows-1252"></head><body>Hi \xe9</body></html>';
    const r = decodeContentText(Buffer.from(html, 'latin1'), null);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.text).toBe(html);
    }
  });

  it('无 meta → UTF-8 默认', () => {
    const html = '<html><head></head><body>hi</body></html>';
    const r = decodeContentText(Buffer.from(html, 'utf8'), null);
    expect(r).toEqual({ kind: 'ok', text: html });
  });
});

describe('decodeContentText — 失败语义', () => {
  it('未知 charset → unsupported_charset', () => {
    const r = decodeContentText(Buffer.from('hi', 'utf8'), 'text/html; charset=bogus-encoding');
    expect(r).toEqual({ kind: 'unsupported_charset', label: 'bogus-encoding' });
  });

  it('fatal 解码失败 → decode_failed（UTF-8 非法字节）', () => {
    const r = decodeContentText(Buffer.from([0x48, 0x69, 0xff]), 'text/html; charset=utf-8');
    expect(r).toEqual({ kind: 'decode_failed', label: 'utf-8' });
  });
});
