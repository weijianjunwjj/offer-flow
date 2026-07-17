import type { EventTimePrecision } from '../../domain/job-memory';
import { formatDateTime, formatTimePrecisionLabel } from '../../domain/presentation';

export interface EventTimeResult {
  ok: boolean;
  value: number | null;
  error: string;
}

function failure(error: string): EventTimeResult {
  return { ok: false, value: null, error };
}

function validDateParts(year: number, month: number, day: number): boolean {
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

function parseDateOnly(input: string): EventTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) return failure('日期格式必须为 YYYY-MM-DD');
  const [, yearText, monthText, dayText] = match;
  const [year, month, day] = [Number(yearText), Number(monthText), Number(dayText)];
  if (!validDateParts(year, month, day)) return failure('日期不存在');
  // date 精度统一编码为该公历日 UTC 12:00，避免跨时区显示时滑到前后一天。
  return { ok: true, value: Date.UTC(year, month - 1, day, 12), error: '' };
}

function parseLocalDateTime(input: string): EventTimeResult {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) return failure('时间格式必须为 YYYY-MM-DDTHH:mm');
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const [year, month, day, hour, minute] = [
    Number(yearText), Number(monthText), Number(dayText), Number(hourText), Number(minuteText),
  ];
  if (!validDateParts(year, month, day) || hour > 23 || minute > 59) {
    return failure('日期或时间不存在');
  }
  const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1
    || candidate.getDate() !== day
    || candidate.getHours() !== hour
    || candidate.getMinutes() !== minute
  ) {
    return failure('该本地时间不存在或受时区切换影响');
  }
  return { ok: true, value: candidate.getTime(), error: '' };
}

export function encodeEventTime(
  input: string,
  precision: EventTimePrecision,
): EventTimeResult {
  if (precision === 'unknown') return { ok: true, value: null, error: '' };
  if (input.trim() === '') return failure('请填写发生时间');
  return precision === 'date' ? parseDateOnly(input) : parseLocalDateTime(input);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function decodeEventTimeInput(
  value: number | null,
  precision: EventTimePrecision,
): string {
  if (value === null || precision === 'unknown') return '';
  const date = new Date(value);
  if (precision === 'date') {
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatEventTime(
  value: number | null,
  precision: EventTimePrecision,
): string {
  if (value === null || precision === 'unknown') return '发生时间未知';
  if (precision === 'date') return `${decodeEventTimeInput(value, precision)}（仅日期）`;
  const text = formatDateTime(value);
  return precision === 'approximate' ? `约 ${text}` : text;
}

export function eventTimePrecisionLabel(precision: EventTimePrecision): string {
  return formatTimePrecisionLabel(precision);
}
