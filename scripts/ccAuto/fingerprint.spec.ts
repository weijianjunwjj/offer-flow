import { describe, expect, it } from 'vitest';
import { computeFailureFingerprint, normalizeFailureText, truncateLog } from './fingerprint';

describe('normalizeFailureText / computeFailureFingerprint', () => {
  it('同一根因、不同时间戳与行号 → 指纹相同', () => {
    const a = 'Error at foo.ts:12:5\n2026-07-30T10:00:00Z assertion failed';
    const b = 'Error at foo.ts:99:1\n2026-07-30T11:30:00Z assertion failed';
    expect(computeFailureFingerprint(a)).toBe(computeFailureFingerprint(b));
  });

  it('不同根因 → 指纹不同', () => {
    const a = 'TypeError: cannot read property x';
    const b = 'ReferenceError: y is not defined';
    expect(computeFailureFingerprint(a)).not.toBe(computeFailureFingerprint(b));
  });

  it('归一化会替换十六进制哈希与运行目录路径', () => {
    const text = '/repo/.cc-auto/runs/run-123abc/phases/IMPLEMENT.json failed with hash deadbeef1234';
    const normalized = normalizeFailureText(text);
    expect(normalized).not.toContain('deadbeef1234');
    expect(normalized).not.toContain('run-123abc');
  });
});

describe('truncateLog', () => {
  it('短日志原样返回', () => {
    const text = 'line1\nline2';
    expect(truncateLog(text, 60)).toBe(text);
  });

  it('长日志被裁剪并保留首尾', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line${i}`);
    const result = truncateLog(lines.join('\n'), 60);
    expect(result).toContain('line0');
    expect(result).toContain('line199');
    expect(result).toContain('省略');
    expect(result.split('\n').length).toBeLessThan(200);
  });
});
