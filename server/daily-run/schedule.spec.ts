import { describe, expect, it } from 'vitest';
import {
  computeNextOccurrence,
  computeScheduledDay,
  computeTodayOccurrence,
  DEFAULT_TIMEZONE,
  isValidIanaTimeZone,
  normalizeScheduleInput,
  parseDailySearchSchedule,
  todayInTimeZone,
} from './schedule';

describe('parseDailySearchSchedule', () => {
  it('解析合法 dailyAt + timezone', () => {
    expect(parseDailySearchSchedule({ dailyAt: '09:00', timezone: 'Asia/Shanghai' })).toEqual({
      dailyAt: '09:00',
      timezone: 'Asia/Shanghai',
    });
  });

  it('timezone 缺失补默认 Asia/Shanghai（历史数据兼容）', () => {
    expect(parseDailySearchSchedule({ dailyAt: '09:00' }).timezone).toBe(DEFAULT_TIMEZONE);
  });

  it('非法 dailyAt 抛错', () => {
    expect(() => parseDailySearchSchedule({ dailyAt: '25:00', timezone: 'Asia/Shanghai' })).toThrow(/dailyAt/);
    expect(() => parseDailySearchSchedule({ dailyAt: '9:00', timezone: 'Asia/Shanghai' })).toThrow(/dailyAt/);
  });

  it('非法 IANA timezone 抛错', () => {
    expect(() => parseDailySearchSchedule({ dailyAt: '09:00', timezone: 'Not/AZone' })).toThrow(/timezone/);
  });
});

describe('normalizeScheduleInput（T022 DTO 规范化）', () => {
  it('缺 dailyAt → 09:00，缺 timezone → Asia/Shanghai', () => {
    expect(normalizeScheduleInput({})).toEqual({ dailyAt: '09:00', timezone: 'Asia/Shanghai' });
  });

  it('timezone omitted → Asia/Shanghai', () => {
    expect(normalizeScheduleInput({ dailyAt: '08:30' })).toEqual({ dailyAt: '08:30', timezone: 'Asia/Shanghai' });
  });

  it('显式 IANA timezone round-trip', () => {
    expect(normalizeScheduleInput({ dailyAt: '09:00', timezone: 'Asia/Singapore' })).toEqual({
      dailyAt: '09:00',
      timezone: 'Asia/Singapore',
    });
  });
});

describe('timezone occurrence 计算', () => {
  const schedule = { dailyAt: '09:00', timezone: 'Asia/Shanghai' };

  it('09:00 Asia/Shanghai 映射到正确 UTC instant（UTC+8）', () => {
    // 2026-08-14 00:00 UTC = 08:00 Shanghai，尚未到 09:00 → next = 今天 09:00 Shanghai = 01:00 UTC。
    const now = Date.UTC(2026, 7, 14, 0, 0);
    const next = computeNextOccurrence(schedule, now);
    expect(next.scheduledFor).toBe(Date.UTC(2026, 7, 14, 1, 0));
    expect(next.scheduledDay).toBe('2026-08-14');
  });

  it('已过今日 09:00 → next 取明日', () => {
    const now = Date.UTC(2026, 7, 14, 2, 0); // 10:00 Shanghai
    const next = computeNextOccurrence(schedule, now);
    expect(next.scheduledFor).toBe(Date.UTC(2026, 7, 15, 1, 0));
    expect(next.scheduledDay).toBe('2026-08-15');
  });

  it('computeTodayOccurrence 返回今日 occurrence（catch-up 判断用）', () => {
    const now = Date.UTC(2026, 7, 14, 2, 0); // 10:00 Shanghai，已过 09:00
    const today = computeTodayOccurrence(schedule, now);
    expect(today.scheduledFor).toBe(Date.UTC(2026, 7, 14, 1, 0));
    expect(today.scheduledDay).toBe('2026-08-14');
  });

  it('natural day 使用 plan timezone 而非 UTC date', () => {
    // 2026-08-13 20:00 UTC = 2026-08-14 04:00 Shanghai → 自然日是 08-14，不是 UTC 的 08-13。
    const instant = Date.UTC(2026, 7, 13, 20, 0);
    expect(computeScheduledDay(instant, 'Asia/Shanghai')).toBe('2026-08-14');
    expect(todayInTimeZone(instant, 'Asia/Shanghai')).toBe('2026-08-14');
  });

  it('timezone 变更改变 occurrence 语义（非机器 local timezone）', () => {
    // 同一 UTC 时刻，New_York 与 Shanghai 的自然日不同。
    const instant = Date.UTC(2026, 7, 13, 20, 0);
    expect(computeScheduledDay(instant, 'America/New_York')).toBe('2026-08-13');
    expect(computeScheduledDay(instant, 'Asia/Shanghai')).toBe('2026-08-14');
  });

  it('isValidIanaTimeZone 校验 IANA identifier', () => {
    expect(isValidIanaTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidIanaTimeZone('America/New_York')).toBe(true);
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
  });
});
