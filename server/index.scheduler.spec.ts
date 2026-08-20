import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db';
import { buildServer, resolveDailyJobSchedulerCapability, resolveDailySearchPlanCapability } from './index';
import { DailyJobScheduler } from './scheduler/DailyJobScheduler';
import { initSchema } from './schema';
import { DAILY_JOB_SCHEDULER_SCHEMA_VERSION } from './migrations';

/**
 * T028 Production Activation —— production-entry-level 测试。
 *
 * 不是只测 `new DailyJobScheduler()`，而是走真实 environment/config → buildServer/bootstrap
 * → scheduler capability 链：flag OFF 不启动、flag ON 构造并 onReady start、close 时 stop、
 * dailySearchPlan API 单独开启不连带调度。外部 Tavily/LLM 边界由"空库无 active plan"保证
 * 不触达（scheduler.start() 在无计划时仅空转，不发任何网络请求）。
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
});

function makeSchedulerDb(): { db: ReturnType<typeof openDb>; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offerflow-index-scheduler-'));
  const db = openDb(path.join(tempDir, 'injected.sqlite3'));
  initSchema(db, { targetVersion: DAILY_JOB_SCHEDULER_SCHEMA_VERSION });
  return { db, tempDir };
}

describe('resolveDailyJobSchedulerCapability（OFFERFLOW_DAILY_JOB_SCHEDULER 开关契约）', () => {
  it('absent / 空串 / 非 true → undefined（默认关闭，不构造 Scheduler）', () => {
    expect(resolveDailyJobSchedulerCapability({})).toBeUndefined();
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: '' })).toBeUndefined();
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: 'false' })).toBeUndefined();
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: '0' })).toBeUndefined();
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: '1' })).toBeUndefined();
  });

  it('true（大小写/空白容忍）→ { enabled: true }', () => {
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: 'true' }))
      .toEqual({ enabled: true });
    expect(resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: ' TRUE ' }))
      .toEqual({ enabled: true });
  });
});

describe('resolveDailySearchPlanCapability（OFFERFLOW_DAILY_SEARCH_PLAN 开关契约）', () => {
  it('absent / 空串 / 非 true → undefined（默认关闭，不注册控制 API）', () => {
    expect(resolveDailySearchPlanCapability({})).toBeUndefined();
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: '' })).toBeUndefined();
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: 'false' })).toBeUndefined();
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: '0' })).toBeUndefined();
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: '1' })).toBeUndefined();
  });

  it('true（大小写/空白容忍）→ { enabled: true }', () => {
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: 'true' }))
      .toEqual({ enabled: true });
    expect(resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: ' TRUE ' }))
      .toEqual({ enabled: true });
  });
});

describe('buildServer dailyJobScheduler 生命周期（production-entry-level）', () => {
  it('flag ON → 构造 runtime，onReady start，onClose stop', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');
    const stopSpy = vi.spyOn(DailyJobScheduler.prototype, 'stop');

    const app = buildServer({
      db,
      dailyJobScheduler: resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: 'true' }),
    });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      expect(startSpy).not.toHaveBeenCalled();
      await app.ready();
      await app.listen({ port: 0 }); // 触发 onListen
      // onListen 钩子中有动态 import，等待足够时间让异步钩子完成
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(startSpy).toHaveBeenCalledTimes(1);
      await closeOnce();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      await closeOnce();
    }
  });

  it('flag OFF（不传 dailyJobScheduler）→ 不构造/不启动 Scheduler', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');
    const stopSpy = vi.spyOn(DailyJobScheduler.prototype, 'stop');

    const app = buildServer({ db });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      await app.ready();
      await closeOnce();
      expect(startSpy).not.toHaveBeenCalled();
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      await closeOnce();
    }
  });

  it('dailySearchPlan API 开启 ≠ 调度开启（API 单独开启不启动 Scheduler）', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');

    const app = buildServer({
      db,
      dailySearchPlan: { enabled: true },
      // 刻意不传 dailyJobScheduler：API 与调度解耦。
    });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      await app.ready();
      await closeOnce();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      await closeOnce();
    }
  });

  it('dailySearchPlan ON + scheduler OFF → 控制 API 可用，timer 不启动', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');

    const app = buildServer({
      db,
      dailySearchPlan: resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: 'true' }),
      // 刻意不传 dailyJobScheduler：API 与调度解耦。
    });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      const res = await app.inject({ method: 'GET', url: '/daily-search-plans' });
      expect(res.statusCode).toBe(200);
      await closeOnce();
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      await closeOnce();
    }
  });

  it('dailySearchPlan OFF + scheduler ON → timer 独立运行，控制 API 不注册', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');
    const stopSpy = vi.spyOn(DailyJobScheduler.prototype, 'stop');

    const app = buildServer({
      db,
      dailyJobScheduler: resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: 'true' }),
      // 刻意不传 dailySearchPlan：调度独立运行。
    });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      const res = await app.inject({ method: 'GET', url: '/daily-search-plans' });
      expect(res.statusCode).toBe(404);
      await app.ready();
      await app.listen({ port: 0 }); // 触发 onListen
      // onListen 钩子中有动态 import，需要短暂等待异步完成
      await new Promise(resolve => setImmediate(resolve));
      expect(startSpy).toHaveBeenCalledTimes(1);
      await closeOnce();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      await closeOnce();
    }
  });

  it('两者 ON → 控制 API 可用 且 timer 启动', async () => {
    const { db, tempDir } = makeSchedulerDb();
    const startSpy = vi.spyOn(DailyJobScheduler.prototype, 'start');
    const stopSpy = vi.spyOn(DailyJobScheduler.prototype, 'stop');

    const app = buildServer({
      db,
      dailySearchPlan: resolveDailySearchPlanCapability({ OFFERFLOW_DAILY_SEARCH_PLAN: 'true' }),
      dailyJobScheduler: resolveDailyJobSchedulerCapability({ OFFERFLOW_DAILY_JOB_SCHEDULER: 'true' }),
    });

    let closed = false;
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    cleanups.push(closeOnce);

    try {
      const res = await app.inject({ method: 'GET', url: '/daily-search-plans' });
      expect(res.statusCode).toBe(200);
      await app.ready();
      await app.listen({ port: 0 }); // 触发 onListen
      // onListen 钩子中有动态 import，需要短暂等待异步完成
      await new Promise(resolve => setImmediate(resolve));
      expect(startSpy).toHaveBeenCalledTimes(1);
      await closeOnce();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      await closeOnce();
    }
  });
});
