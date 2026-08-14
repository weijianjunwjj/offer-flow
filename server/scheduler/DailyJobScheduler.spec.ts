import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { DAILY_JOB_SCHEDULER_SCHEMA_VERSION, runMigrations } from '../migrations';
import { SearchPlanRepository } from '../search-plan/searchPlanRepository';
import { DailyJobScheduler } from './DailyJobScheduler';
import type { DailyRunCoordinator } from '../daily-run/DailyRunCoordinator';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-scheduler-'));
let seq = 0;

interface TimerEntry { fn: () => void; ms: number }

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function withScheduler(run: (ctx: {
  scheduler: DailyJobScheduler;
  coordinatorRun: ReturnType<typeof vi.fn>;
  timers: TimerEntry[];
  db: Database.Database;
  setNow: (ms: number) => void;
}) => Promise<void>): Promise<void> {
  return (async () => {
    seq += 1;
    const db = openDb(path.join(tempDir, `scenario-${seq}.sqlite3`));
    runMigrations(db, { targetVersion: DAILY_JOB_SCHEDULER_SCHEMA_VERSION });
    const planRepo = new SearchPlanRepository(db);
    const base = Date.UTC(2026, 7, 14, 0, 0);
    planRepo.insertPlan({
      id: 'plan-1', name: '每日前端岗位', status: 'active', activeVersionId: null,
      createdAt: base, updatedAt: base, deletedAt: null,
    });
    planRepo.insertVersion({
      id: 'version-1', searchPlanId: 'plan-1', version: 1,
      cities: [{ name: '苏州', priority: 1 }], roleDirections: ['前端开发'], baseKeywords: ['React'],
      expandedKeywords: [], hardConstraints: [], sourceConfigs: [{ providerKey: 'tavily', enabled: true }],
      schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' },
      scanBudget: { maxQueriesPerRun: 5 }, analysisBudget: {}, briefPolicy: {},
      explorationPolicy: {}, notificationPolicy: {}, latestCatchUpTime: '12:00',
      createdAt: base, activatedAt: base, supersedesVersionId: null,
    });
    planRepo.setActiveVersion('plan-1', 'version-1');

    const coordinatorRun = vi.fn(async () => ({ outcome: 'completed', sourceRunId: 'run-x', status: 'SUCCEEDED', briefId: null }) as const);
    const coordinator = { run: coordinatorRun } as unknown as DailyRunCoordinator;
    const timers: TimerEntry[] = [];
    let now = base;

    const scheduler = new DailyJobScheduler({
      planRepo,
      coordinator,
      now: () => now,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: vi.fn(),
    });

    await run({
      scheduler, coordinatorRun, timers, db,
      setNow: (ms) => { now = ms; },
    });
    db.close();
  })();
}

describe('DailyJobScheduler（T028）', () => {
  it('start 幂等：重复 start 不产生多个 timer', async () => {
    await withScheduler(async ({ scheduler, timers }) => {
      scheduler.start();
      scheduler.start();
      await flush();
      // 一次 catchUp + 一次 scheduleNext 的 timer。
      expect(timers.length).toBe(1);
    });
  });

  it('startup missed occurrence → CATCH_UP（scheduledFor = 原计划时刻）', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, setNow }) => {
      // 10:00 Shanghai（已过 09:00，仍在 12:00 catch-up 窗口内）。
      setNow(Date.UTC(2026, 7, 14, 2, 0));
      scheduler.start();
      await flush();
      expect(coordinatorRun).toHaveBeenCalledTimes(1);
      const call = coordinatorRun.mock.calls[0]?.[0];
      expect(call.triggerType).toBe('CATCH_UP');
      expect(call.scheduledFor).toBe(Date.UTC(2026, 7, 14, 1, 0)); // 09:00 Shanghai
      expect(call.scheduledDay).toBe('2026-08-14');
    });
  });

  it('startup before 09:00 → 不 catch-up', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, setNow }) => {
      setNow(Date.UTC(2026, 7, 14, 0, 0)); // 08:00 Shanghai
      scheduler.start();
      await flush();
      expect(coordinatorRun).not.toHaveBeenCalled();
    });
  });

  it('catch-up 窗口已过（now > latestCatchUpTime）→ 不 catch-up', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, setNow }) => {
      setNow(Date.UTC(2026, 7, 14, 5, 0)); // 13:00 Shanghai > 12:00
      scheduler.start();
      await flush();
      expect(coordinatorRun).not.toHaveBeenCalled();
    });
  });

  it('future occurrence 不提前触发；timer 延迟到今日 09:00', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, timers, setNow }) => {
      setNow(Date.UTC(2026, 7, 14, 0, 30)); // 08:30 Shanghai
      scheduler.start();
      await flush();
      expect(coordinatorRun).not.toHaveBeenCalled();
      expect(timers.length).toBe(1);
      expect(timers[0]?.ms).toBe(Date.UTC(2026, 7, 14, 1, 0) - Date.UTC(2026, 7, 14, 0, 30)); // 30 分钟
    });
  });

  it('stop 幂等且 stop 后不再启动新 run', async () => {
    await withScheduler(async ({ scheduler, timers, coordinatorRun }) => {
      scheduler.start();
      await flush();
      scheduler.stop();
      scheduler.stop();
      const before = timers.length;
      // 手动触发遗留 timer（不应再产生新 run）。
      timers.forEach((t) => t.fn());
      await flush();
      expect(timers.length).toBe(before);
      expect(coordinatorRun).not.toHaveBeenCalled();
    });
  });

  it('run failure 后 scheduler 继续调度（不因单次失败死亡）', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, timers, setNow }) => {
      coordinatorRun.mockRejectedValueOnce(new Error('boom'));
      setNow(Date.UTC(2026, 7, 14, 2, 0)); // 10:00 → catch-up 触发一次（失败）
      scheduler.start();
      await flush();
      expect(coordinatorRun).toHaveBeenCalledTimes(1);
      // scheduleNext 仍安排了 timer（到明日 09:00）。
      expect(timers.length).toBe(1);
    });
  });

  it('stop 后 tick 不再触发 run', async () => {
    await withScheduler(async ({ scheduler, coordinatorRun, timers, setNow }) => {
      setNow(Date.UTC(2026, 7, 14, 2, 0));
      scheduler.start();
      await flush();
      scheduler.stop();
      const timer = timers[0];
      // 模拟 timer 到期 tick（started=false 时应直接返回）。
      timer?.fn();
      await flush();
      expect(coordinatorRun).toHaveBeenCalledTimes(1); // 仅 catch-up 一次，无额外 tick run
    });
  });
});
