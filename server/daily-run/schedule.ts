/**
 * OfferFlow v0.9 — DailySearchPlanVersion.schedule 结构化类型 + timezone 计算。
 *
 * T028 + DailyRunCoordinator Architecture Decision：
 *   schedule contract = { dailyAt: "HH:mm", timezone: "IANA timezone" }
 *   v0.9 产品默认 timezone = Asia/Shanghai（明确产品决策，非机器推断）
 *
 * 关键约束：
 *   - timezone 使用 IANA identifier，不硬编码 +08:00、不读 process.env.TZ、不读机器 local timezone；
 *   - scheduledFor = 该 occurrence 对应的绝对 UTC instant（epoch ms）；
 *   - scheduledDay = 该 occurrence 在 PlanVersion.schedule.timezone 下的本地自然日 YYYY-MM-DD；
 *   - scheduledDay 禁止按 UTC date 截取获得。
 *
 * DST 策略（明确收敛，不虚假泛化）：
 *   v0.9 officially supported timezone = Asia/Shanghai（无 DST）。domain/storage 仍用 IANA
 *   字段以保留扩展 contract；其它 IANA 时区用标准 Intl 能力 best-effort（ambiguous 取首次合法
 *   occurrence，nonexistent 移到该日第一个合法时刻），不引入第三方 timezone dependency。
 */

export interface DailySearchSchedule {
  /** 严格 HH:mm，00:00–23:59。 */
  dailyAt: string;
  /** IANA timezone identifier（如 Asia/Shanghai）。 */
  timezone: string;
}

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 校验 IANA timezone identifier（用标准 Intl 能力，不维护 allowlist）。 */
export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function isValidDailyAt(dailyAt: string): boolean {
  return DAILY_AT_RE.test(dailyAt);
}

/**
 * 把「已持久化的 schedule JSON」解析为结构化 DailySearchSchedule。
 * 历史数据可能缺失 timezone（contract 落地前），此处按 v0.9 决策补默认。
 * 非法 dailyAt / 非法 IANA timezone 抛错。
 */
export function parseDailySearchSchedule(schedule: unknown): DailySearchSchedule {
  if (schedule === null || typeof schedule !== 'object') {
    throw new Error('schedule 必须是对象');
  }
  const raw = schedule as Record<string, unknown>;
  const dailyAt = typeof raw.dailyAt === 'string' ? raw.dailyAt : '';
  const timezone = typeof raw.timezone === 'string' ? raw.timezone : DEFAULT_TIMEZONE;
  if (!isValidDailyAt(dailyAt)) {
    throw new Error(`schedule.dailyAt 非法（需 HH:mm）: ${dailyAt}`);
  }
  if (!isValidIanaTimeZone(timezone)) {
    throw new Error(`schedule.timezone 非法 IANA identifier: ${timezone}`);
  }
  return { dailyAt, timezone };
}

/**
 * T022 DTO 输入规范化：dailyAt 缺省 → '09:00'，timezone 缺省 → Asia/Shanghai
 * （v0.9 backward-compatible UX）。返回已规范化的 schedule 对象（持久化时显式含 timezone）。
 */
export function normalizeScheduleInput(schedule: unknown): { dailyAt: string; timezone: string } {
  const raw = (schedule ?? {}) as Record<string, unknown>;
  const dailyAt = typeof raw.dailyAt === 'string' && raw.dailyAt !== '' ? raw.dailyAt : '09:00';
  const timezone = typeof raw.timezone === 'string' && raw.timezone !== '' ? raw.timezone : DEFAULT_TIMEZONE;
  return parseDailySearchSchedule({ dailyAt, timezone });
}

// ── Timezone 计算（标准 Intl，无第三方依赖）─────────────────────────────────────

interface ZonedParts {
  year: number;
  month: number; // 1-based
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** instant 在 timeZone 下的 UTC offset（ms，正值 = 早于 UTC）。 */
function zonedOffsetMs(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - instant;
}

/** 把 timeZone 下的一处 wall-clock 时间（y/mo/d h:mi）转成绝对 instant。 */
function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = zonedOffsetMs(guess, timeZone);
  const adjusted = guess - offset1;
  // DST 边界：若 offset 变化再调整一次（无 DST 时 offset1 === offset2）。
  const offset2 = zonedOffsetMs(adjusted, timeZone);
  if (offset1 === offset2) return adjusted;
  return guess - offset2;
}

/** 该 instant 在 timeZone 下的本地自然日 YYYY-MM-DD。 */
export function computeScheduledDay(instant: number, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/** now 在 timeZone 下的当前自然日 YYYY-MM-DD。 */
export function todayInTimeZone(now: number, timeZone: string): string {
  return computeScheduledDay(now, timeZone);
}

/**
 * 计算下一次 scheduled occurrence（绝对 instant + 本地自然日）。
 * 若 today 的 dailyAt 已过，则取明天。
 */
export function computeNextOccurrence(
  schedule: DailySearchSchedule,
  now: number,
): { scheduledFor: number; scheduledDay: string } {
  const [hour, minute] = schedule.dailyAt.split(':').map((s) => Number(s));
  const p = zonedParts(now, schedule.timezone);
  const todayOccurrence = zonedWallTimeToInstant(p.year, p.month, p.day, hour!, minute!, schedule.timezone);
  const occurrence = todayOccurrence > now
    ? todayOccurrence
    : zonedWallTimeToInstant(p.year, p.month, p.day + 1, hour!, minute!, schedule.timezone);
  return { scheduledFor: occurrence, scheduledDay: computeScheduledDay(occurrence, schedule.timezone) };
}

/** 计算「今天（timeZone 自然日）+ dailyAt」对应的绝对 occurrence（用于 startup catch-up 判断）。 */
export function computeTodayOccurrence(
  schedule: DailySearchSchedule,
  now: number,
): { scheduledFor: number; scheduledDay: string } {
  const [hour, minute] = schedule.dailyAt.split(':').map((s) => Number(s));
  const p = zonedParts(now, schedule.timezone);
  const scheduledFor = zonedWallTimeToInstant(p.year, p.month, p.day, hour!, minute!, schedule.timezone);
  return { scheduledFor, scheduledDay: computeScheduledDay(scheduledFor, schedule.timezone) };
}
