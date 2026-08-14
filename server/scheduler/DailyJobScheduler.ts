import type { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import type { SkipRepository } from '../search-plan/skipRepository';
import type { DailyRunCoordinator } from '../daily-run/DailyRunCoordinator';
import { computeNextOccurrence, computeTodayOccurrence, parseDailySearchSchedule, type DailySearchSchedule } from '../daily-run/schedule';
import type { DailySearchPlanVersion } from '../search-plan/types';

/**
 * DailyJobScheduler —— WHEN（T028 调度器）。
 *
 * 只负责：读取 active PlanVersion、计算 scheduled occurrence、startup catch-up、
 * setTimeout 链、防止重复调度、调 DailyRunCoordinator、start/stop 生命周期。
 * 不负责 Search/Fetch/Upgrade/Analysis/Recommendation/Brief 内容构建。
 *
 * 实现约束：
 *   - setTimeout 链（一次 tick 完成后安排下一次，禁止 setInterval/node-cron/external cron）；
 *   - start/stop 幂等；重复 start 不产生多个 timer；stop 后不再启动新 run；
 *   - 时间可测试（now / setTimeout / clearTimeout 注入，vitest fake timer）；
 *   - in-memory running set 仅 fast path，真正的防重靠 SourceRun partial UNIQUE。
 */

export interface DailyJobSchedulerDeps {
  planRepo: SearchPlanRepository;
  coordinator: DailyRunCoordinator;
  skipRepo: SkipRepository;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export class DailyJobScheduler {
  private readonly planRepo: SearchPlanRepository;
  private readonly coordinator: DailyRunCoordinator;
  private readonly skipRepo: SkipRepository;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  private started = false;
  private timerHandle: unknown;
  /** in-memory fast path：正在运行/已触发的 planVersionId。 */
  private readonly inFlight = new Set<string>();

  constructor(deps: DailyJobSchedulerDeps) {
    this.planRepo = deps.planRepo;
    this.coordinator = deps.coordinator;
    this.skipRepo = deps.skipRepo;
    this.now = deps.now ?? Date.now;
    this.setTimeoutFn = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // startup catch-up 后进入 setTimeout 链；tick 完成后才安排下一次，避免 callback 堆叠。
    void this.catchUp().finally(() => this.scheduleNext());
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timerHandle !== undefined) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = undefined;
    }
  }

  // ── 调度主链 ────────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.started) return;
    const delay = this.computeNextDelay();
    if (delay === null) return;
    this.timerHandle = this.setTimeoutFn(() => {
      this.timerHandle = undefined;
      if (!this.started) return; // stop 后不再 tick
      void this.tick().finally(() => this.scheduleNext());
    }, delay);
  }

  private computeNextDelay(): number | null {
    const now = this.now();
    let minDelay = Number.POSITIVE_INFINITY;
    for (const plan of this.planRepo.listActivePlans()) {
      const version = this.activeVersion(plan.id);
      if (version === null) continue;
      const schedule = safeParseSchedule(version);
      if (schedule === null) continue;
      const next = computeNextOccurrence(schedule, now);
      minDelay = Math.min(minDelay, next.scheduledFor - now);
    }
    if (!Number.isFinite(minDelay)) return null;
    return Math.max(0, minDelay);
  }

  private async tick(): Promise<void> {
    const now = this.now();
    for (const plan of this.planRepo.listActivePlans()) {
      const version = this.activeVersion(plan.id);
      if (version === null) continue;
      const schedule = safeParseSchedule(version);
      if (schedule === null) continue;
      const todayOcc = computeTodayOccurrence(schedule, now);
      if (now >= todayOcc.scheduledFor) {
        await this.trigger(version, 'SCHEDULED', todayOcc.scheduledFor, todayOcc.scheduledDay);
      }
    }
  }

  private async catchUp(): Promise<void> {
    const now = this.now();
    for (const plan of this.planRepo.listActivePlans()) {
      const version = this.activeVersion(plan.id);
      if (version === null) continue;
      const schedule = safeParseSchedule(version);
      if (schedule === null) continue;
      const todayOcc = computeTodayOccurrence(schedule, now);
      // 今天 occurrence 已过，且仍在 latestCatchUpTime 范围内 → 补一次 CATCH_UP。
      if (now > todayOcc.scheduledFor && this.withinCatchUp(now, schedule, version.latestCatchUpTime)) {
        await this.trigger(version, 'CATCH_UP', todayOcc.scheduledFor, todayOcc.scheduledDay);
      }
    }
  }

  private withinCatchUp(now: number, schedule: DailySearchSchedule, latestCatchUpTime: string): boolean {
    try {
      const catchUpOcc = computeTodayOccurrence({ dailyAt: latestCatchUpTime, timezone: schedule.timezone }, now);
      return now <= catchUpOcc.scheduledFor;
    } catch {
      return false;
    }
  }

  private async trigger(
    version: DailySearchPlanVersion,
    triggerType: 'SCHEDULED' | 'CATCH_UP',
    scheduledFor: number,
    scheduledDay: string,
  ): Promise<void> {
    if (this.inFlight.has(version.id)) return; // in-memory fast path
    // Skip Today：该 PlanVersion 该自然日被用户明确跳过 → 不 SCHEDULED / 不 CATCH_UP。
    // 下一自然日自动恢复；MANUAL Run Now 不经过本路径（只跳过自动 occurrence）。
    if (this.skipRepo.isSkipped(version.id, scheduledDay)) return;
    this.inFlight.add(version.id);
    try {
      await this.coordinator.run({
        searchPlanVersionId: version.id,
        triggerType,
        scheduledFor,
        scheduledDay,
      });
    } catch {
      // 单次 run-level fatal：不终止 scheduler，继续下一个合法 occurrence（SourceRun 终态由 coordinator 处理）。
    } finally {
      this.inFlight.delete(version.id);
    }
  }

  private activeVersion(planId: string): DailySearchPlanVersion | null {
    return this.planRepo.getActiveVersion(planId);
  }
}

function safeParseSchedule(version: DailySearchPlanVersion): DailySearchSchedule | null {
  try {
    return parseDailySearchSchedule(version.schedule);
  } catch {
    return null;
  }
}
