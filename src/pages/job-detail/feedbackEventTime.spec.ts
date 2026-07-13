import { describe, expect, it } from 'vitest';
import {
  decodeEventTimeInput,
  encodeEventTime,
  formatEventTime,
} from './feedbackEventTime';

describe('FeedbackEvent 时间编码', () => {
  it.each([
    ['exact', '2026-07-13T09:45'],
    ['approximate', '2026-07-13T09:45'],
    ['date', '2026-07-13'],
  ] as const)('%s 使用显式组件编码并可 round-trip', (precision, input) => {
    const encoded = encodeEventTime(input, precision);
    expect(encoded).toMatchObject({ ok: true, error: '' });
    expect(encoded.value).not.toBeNull();
    expect(decodeEventTimeInput(encoded.value, precision)).toBe(input);
  });

  it('date 固定使用 UTC 正午，避免跨时区滑到相邻日期', () => {
    const encoded = encodeEventTime('2026-01-02', 'date');
    expect(encoded.value).toBe(Date.UTC(2026, 0, 2, 12));
    expect(formatEventTime(encoded.value, 'date')).toBe('2026-01-02（仅日期）');
  });

  it('unknown 永远编码为 null，不使用输入或当前时间', () => {
    expect(encodeEventTime('', 'unknown')).toEqual({ ok: true, value: null, error: '' });
    expect(encodeEventTime('2026-07-13T09:45', 'unknown').value).toBeNull();
    expect(formatEventTime(null, 'unknown')).toBe('发生时间未知');
  });

  it.each([
    ['2026-02-30', 'date'],
    ['2026-07-13 09:45', 'exact'],
    ['2026-07-13T25:00', 'approximate'],
    ['', 'exact'],
  ] as const)('拒绝非法输入 %s / %s', (input, precision) => {
    expect(encodeEventTime(input, precision).ok).toBe(false);
  });
});
