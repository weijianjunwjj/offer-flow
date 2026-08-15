/**
 * OfferFlow v0.9 — Windows Wake Bridge 测试。
 *
 * 覆盖（PHASE 16 点位 7-12）：
 *   7. backend 已健康 → 不启动第二个 backend
 *   8. backend down → 通过正式 launcher 恢复
 *   9. 不调用 Run Now（不 POST /run-now、不调 coordinator/pipeline）
 *   10. 等待 occurrence
 *   11. occurrence 出现（terminal）→ bridge 正常退出
 *   12. bounded timeout → bridge 不永久挂起
 *
 * 全部通过 fake fetchJson / spawnLauncherFn / now / setTimeoutFn 测纯逻辑，绝不真实 spawn / fetch / 触碰 Task Scheduler。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  checkHealth,
  computeTodayOccurrenceLocal,
  main,
  resolveActiveOccurrence,
  waitForOccurrence,
  waitForHealthy,
} from './offerflowWakeBridge.mjs';
import type { WakeBridgeDeps } from './offerflowWakeBridge.mjs';

const NODE = 'D:\\nodejs\\node.exe';
const LAUNCHER = 'D:\\VSCode\\offer-flow\\scripts\\autostart\\offerflowAutostartLauncher.mjs';
const REPO_ROOT = 'D:\\VSCode\\offer-flow';

function makeDeps(overrides: Partial<WakeBridgeDeps> = {}): WakeBridgeDeps & {
  fetchCalls: string[];
} {
  const fetchCalls: string[] = [];
  const fetchJson = vi.fn(async (path: string) => {
    fetchCalls.push(path);
    return { ok: true };
  });
  return {
    repoRoot: REPO_ROOT,
    nodeExecutable: NODE,
    launcherPath: LAUNCHER,
    healthUrl: 'http://127.0.0.1:17365/health',
    holdAwakeWindowMs: 10_000,
    recoverHealthWaitMs: 5_000,
    occurrencePollIntervalMs: 500,
    fetchJson,
    spawnLauncherFn: vi.fn(),
    now: () => new Date(2026, 7, 15, 8, 58, 0).getTime(),
    setTimeoutFn: (fn) => { fn(); return 0; },
    chdirFn: vi.fn(),
    existsSyncFn: vi.fn(() => true),
    mkdirSyncFn: vi.fn(),
    writeLog: vi.fn(),
    ...overrides,
    fetchCalls,
  };
}

describe('computeTodayOccurrenceLocal', () => {
  it('本地自然日 + dailyAt 计算 occurrence', () => {
    // 2026-08-15 08:58 本地，dailyAt=09:00 → 今天 09:00。
    const now = new Date(2026, 7, 15, 8, 58, 0).getTime();
    const occ = computeTodayOccurrenceLocal({ dailyAt: '09:00', now });
    expect(occ.scheduledFor).toBe(new Date(2026, 7, 15, 9, 0, 0).getTime());
    expect(occ.scheduledDay).toBe('2026-08-15');
  });
});

describe('checkHealth', () => {
  it('后端返回 ok=true → healthy', async () => {
    const fetchJson = vi.fn(async () => ({ ok: true }));
    expect(await checkHealth({ fetchJson })).toEqual({ healthy: true });
  });

  it('后端不可达（抛错）→ unhealthy', async () => {
    const fetchJson = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await checkHealth({ fetchJson })).toEqual({ healthy: false });
  });

  it('后端返回非 ok → unhealthy', async () => {
    const fetchJson = vi.fn(async () => ({ ok: false }));
    expect(await checkHealth({ fetchJson })).toEqual({ healthy: false });
  });
});

describe('resolveActiveOccurrence', () => {
  it('解析第一个 active plan 的 occurrence', async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path === '/daily-search-plans') {
        return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
      }
      return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
    });
    const now = () => new Date(2026, 7, 15, 8, 58, 0).getTime();
    const occ = await resolveActiveOccurrence({ fetchJson, now });
    expect(occ).not.toBeNull();
    expect(occ!.planId).toBe('p1');
    expect(occ!.versionId).toBe('v1');
    expect(occ!.scheduledDay).toBe('2026-08-15');
  });

  it('无 active plan → null', async () => {
    const fetchJson = vi.fn(async () => ({ plans: [{ id: 'p1', status: 'paused', activeVersionId: null }] }));
    expect(await resolveActiveOccurrence({ fetchJson, now: () => 0 })).toBeNull();
  });
});

describe('waitForOccurrence', () => {
  const scheduledFor = new Date(2026, 7, 15, 9, 0, 0).getTime();
  const base = {
    planId: 'p1',
    versionId: 'v1',
    scheduledFor,
    scheduledDay: '2026-08-15',
  };

  it('occurrence 进入 terminal → 立即返回 terminal（不 sleep）', async () => {
    const fetchJson = vi.fn(async () => ({
      runs: [{ searchPlanVersionId: 'v1', scheduledFor, status: 'SUCCEEDED' }],
    }));
    const setTimeoutFn = vi.fn();
    const result = await waitForOccurrence({
      ...base,
      fetchJson,
      deadlineMs: 10_000,
      now: () => 0,
      setTimeoutFn,
    });
    expect(result.outcome).toBe('terminal');
    expect(setTimeoutFn).not.toHaveBeenCalled();
  });

  it('occurrence 非 terminal → 继续等待；出现 terminal 后退出', async () => {
    let call = 0;
    const fetchJson = vi.fn(async () => {
      call += 1;
      if (call === 1) return { runs: [{ searchPlanVersionId: 'v1', scheduledFor, status: 'RUNNING' }] };
      return { runs: [{ searchPlanVersionId: 'v1', scheduledFor, status: 'SUCCEEDED' }] };
    });
    let nowValue = 0;
    const now = () => nowValue;
    const setTimeoutFn = vi.fn((fn) => { nowValue += 1; fn(); });
    const result = await waitForOccurrence({
      ...base,
      fetchJson,
      deadlineMs: 1000,
      now,
      setTimeoutFn,
    });
    expect(result.outcome).toBe('terminal');
  });

  it('bounded timeout → 返回 timeout，不永久挂起', async () => {
    const fetchJson = vi.fn(async () => ({ runs: [] }));
    let nowValue = 0;
    const now = () => nowValue;
    const setTimeoutFn = vi.fn((fn, ms: number) => { nowValue += ms; fn(); });
    const result = await waitForOccurrence({
      ...base,
      fetchJson,
      deadlineMs: 100,
      now,
      setTimeoutFn,
    });
    expect(result.outcome).toBe('timeout');
    expect(nowValue).toBeGreaterThanOrEqual(100);
  });
});

describe('waitForHealthy', () => {
  it('backend 恢复健康后返回 healthy', async () => {
    let healthy = false;
    const fetchJson = vi.fn(async () => ({ ok: healthy }));
    let nowValue = 0;
    const now = () => nowValue;
    const setTimeoutFn = vi.fn((fn) => { healthy = true; nowValue += 2000; fn(); });
    const result = await waitForHealthy({ fetchJson, deadlineMs: 10_000, now, setTimeoutFn });
    expect(result.healthy).toBe(true);
  });
});

describe('main — backend 健康与恢复', () => {
  it('backend 已健康 → 不启动第二个 backend', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async (path: string) => {
        if (path.includes('/health')) return { ok: true };
        if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
        if (path === '/daily-search-plans/p1') return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
        if (path.startsWith('/source-runs')) {
          return { runs: [{ searchPlanVersionId: 'v1', scheduledFor: new Date(2026, 7, 15, 9, 0, 0).getTime(), status: 'SUCCEEDED' }] };
        }
        return {};
      }),
    });
    await main(deps);
    expect(deps.spawnLauncherFn).not.toHaveBeenCalled();
  });

  it('backend down → 通过正式 launcher 恢复', async () => {
    const spawnLauncherFn = vi.fn();
    let healthy = false;
    const deps = makeDeps({
      spawnLauncherFn,
      fetchJson: vi.fn(async (path: string) => {
        if (path.includes('/health')) return { ok: healthy };
        if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
        if (path === '/daily-search-plans/p1') return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
        if (path.startsWith('/source-runs')) {
          return { runs: [{ searchPlanVersionId: 'v1', scheduledFor: new Date(2026, 7, 15, 9, 0, 0).getTime(), status: 'SUCCEEDED' }] };
        }
        return {};
      }),
      setTimeoutFn: (fn) => { healthy = true; fn(); return 0; },
    });
    await main(deps);
    expect(spawnLauncherFn).toHaveBeenCalledTimes(1);
    expect(spawnLauncherFn).toHaveBeenCalledWith({ nodeExecutable: NODE, launcherPath: LAUNCHER, repoRoot: REPO_ROOT });
  });

  it('绝不调用 Run Now（不 POST /run-now）', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async (path: string) => {
        if (path.includes('/health')) return { ok: true };
        if (path === '/daily-search-plans') return { plans: [{ id: 'p1', status: 'active', activeVersionId: 'v1' }] };
        if (path === '/daily-search-plans/p1') return { activeVersion: { id: 'v1', schedule: { dailyAt: '09:00', timezone: 'Asia/Shanghai' } } };
        if (path.startsWith('/source-runs')) {
          return { runs: [{ searchPlanVersionId: 'v1', scheduledFor: new Date(2026, 7, 15, 9, 0, 0).getTime(), status: 'SUCCEEDED' }] };
        }
        return {};
      }),
    });
    await main(deps);
    expect(deps.fetchCalls.some((p) => p.includes('run-now'))).toBe(false);
  });

  it('无 active plan → 只保持存活窗口后正常退出，不调用 run-now', async () => {
    const deps = makeDeps({
      fetchJson: vi.fn(async (path: string) => {
        if (path.includes('/health')) return { ok: true };
        if (path === '/daily-search-plans') return { plans: [] };
        return {};
      }),
      holdAwakeWindowMs: 10,
    });
    const result = await main(deps);
    expect(result.exitCode).toBe(0);
    expect(deps.fetchCalls.some((p) => p.includes('run-now'))).toBe(false);
  });

  it('launcher 缺失 → 返回非零退出码，不 spawn', async () => {
    const deps = makeDeps({ existsSyncFn: vi.fn(() => false) });
    const result = await main(deps);
    expect(result.exitCode).toBe(1);
    expect(result.reason).toBe('MISSING_LAUNCHER');
    expect(deps.spawnLauncherFn).not.toHaveBeenCalled();
  });
});
