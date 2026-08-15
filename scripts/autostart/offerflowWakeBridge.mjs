/**
 * OfferFlow v0.9 — Windows Wake Bridge（由 Task Scheduler wake task 在 08:58 唤醒后运行）。
 *
 * 职责必须非常窄：它不跑业务。
 *   - 只确保 host/runtime 存活，让现有 DailyJobScheduler 在 dailyAt 创建正式 SCHEDULED occurrence。
 *   - 绝不调用 run-now API、DailyRunCoordinator.run()、DailyPipeline.run()、不 INSERT source_runs。
 *
 * v0.9 Wake Admin-Bootstrap 语义（RUNTIME POLICY GATE）：
 *   1. chdir 到 repoRoot，确认 launcher 存在。
 *   2. 检查 127.0.0.1:17365/health；已健康 → 不启动第二个 backend；否则经 launcher 恢复。
 *   3. 读取当前 DailySearchPlan（正式 API / read contract）：
 *      无 active plan / paused / deleted → 立即 EXIT_NO_ACTIVE_PLAN（不 hold、不 Run Now、不创建 SourceRun）。
 *   4. schedule drift 检测：读取自身 task 的 configuredDailyAt（bootstrap 时持久化的安全 metadata），
 *      与 active plan dailyAt 比较；不一致 → 记录 WAKE_TASK_STALE=YES，安全退出（绝不 mutation / Run Now / 自动提权）。
 *   5. 一致 → 保持存活：等到对应 SCHEDULED SourceRun 进入 terminal，或达到 bounded timeout（默认 10 分钟）。
 *   6. 正常退出，Windows Task Scheduler 随后可释放 keep-awake。
 *
 * 明确不做：不调用 run-now、不创建 SourceRun、不调 DailyRunCoordinator、不调 DailyPipeline、
 * 不 mutation Windows Task Scheduler、不自动提权。
 * 所有 side effect（fetch / spawn / 文件系统 / 计时器 / schtasks 只读探测）都通过 deps 注入，测试用 fake 替换。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_HOLD_AWAKE_WINDOW_MS,
  HEALTH_TIMEOUT_MS,
  HEALTH_URL,
  OCCURRENCE_POLL_INTERVAL_MS,
  RECOVER_HEALTH_WAIT_MS,
  SOURCE_RUN_TERMINAL_STATUSES,
  WAKE_TASK_NAME,
  buildQueryArgs,
  parseConfiguredScheduleFromDescription,
  parseWakeSchedule,
  parseWakeTaskQueryXml,
} from './wakeCore.mjs';
import {
  composeLogFileName,
  resolveRepoRoot,
} from './autostartCore.mjs';

// ── occurrence 计算（host 本地时间，v0.9 支持时区 = Asia/Shanghai 无 DST）──

/** 计算「今天（host 本地自然日）+ dailyAt」的绝对 instant 与本地自然日（用于观测 SCHEDULED occurrence）。 */
export function computeTodayOccurrenceLocal({ dailyAt, now }) {
  const [h, m] = dailyAt.split(':').map((s) => Number(s));
  const d = new Date(now);
  const scheduledFor = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  const pad = (n) => String(n).padStart(2, '0');
  const scheduledDay = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { scheduledFor, scheduledDay };
}

/** 睡眠 helper（用注入的 setTimeoutFn，测试可 fake）。 */
export function sleep(setTimeoutFn, ms) {
  return new Promise((resolve) => setTimeoutFn(resolve, ms));
}

// ── 健康检查 ────────────────────────────────────────────────────────────────

/** 单次健康检查。fetchJson 注入（失败/非 200/非 ok 均视为 unhealthy）。 */
export async function checkHealth({ fetchJson, healthUrl = HEALTH_URL, timeoutMs = HEALTH_TIMEOUT_MS }) {
  try {
    const resp = await fetchJson(healthUrl, { timeoutMs });
    return { healthy: resp && resp.ok === true };
  } catch {
    return { healthy: false };
  }
}

/** 有界等待 backend 健康（恢复 backend 后轮询，避免无限等待）。 */
export async function waitForHealthy({
  fetchJson,
  healthUrl = HEALTH_URL,
  pollIntervalMs = 2000,
  deadlineMs,
  now,
  setTimeoutFn,
}) {
  while (now() < deadlineMs) {
    const result = await checkHealth({ fetchJson, healthUrl });
    if (result.healthy) return { healthy: true };
    await sleep(setTimeoutFn, Math.min(pollIntervalMs, Math.max(0, deadlineMs - now())));
  }
  return { healthy: false };
}

// ── active occurrence 解析 ──────────────────────────────────────────────────

/** 解析「第一个 active plan 的 activeVersion」对应的今日 SCHEDULED occurrence。无 active plan / 后端不可用 → null。 */
export async function resolveActiveOccurrence({ fetchJson, now }) {
  let plansResponse;
  try {
    plansResponse = await fetchJson('/daily-search-plans');
  } catch {
    return null;
  }
  const plans = plansResponse && Array.isArray(plansResponse.plans) ? plansResponse.plans : [];
  const active = plans.find((p) => p.status === 'active' && p.activeVersionId !== null);
  if (active === undefined) return null;

  let detail;
  try {
    detail = await fetchJson(`/daily-search-plans/${active.id}`);
  } catch {
    return null;
  }
  const version = detail && detail.activeVersion ? detail.activeVersion : null;
  if (version === null || version.schedule === undefined) return null;

  let schedule;
  try {
    schedule = parseWakeSchedule(version.schedule);
  } catch {
    return null;
  }
  const occ = computeTodayOccurrenceLocal({ dailyAt: schedule.dailyAt, now: now() });
  return {
    planId: active.id,
    versionId: version.id,
    scheduledFor: occ.scheduledFor,
    scheduledDay: occ.scheduledDay,
    schedule,
  };
}

// ── occurrence 观测（等待 terminal 或 bounded timeout）───────────────────────

/**
 * 观测本地正式 SCHEDULED SourceRun（searchPlanVersionId + scheduledFor 精确匹配）直到 terminal 或 timeout。
 * 绝不创建 SourceRun，只读 /source-runs 观测。
 */
export async function waitForOccurrence({
  fetchJson,
  planId,
  versionId,
  scheduledFor,
  scheduledDay,
  pollIntervalMs = OCCURRENCE_POLL_INTERVAL_MS,
  deadlineMs,
  now,
  setTimeoutFn,
}) {
  while (now() < deadlineMs) {
    let runs = [];
    try {
      const query = `/source-runs?planId=${encodeURIComponent(planId)}&triggerType=SCHEDULED&day=${scheduledDay}`;
      const resp = await fetchJson(query);
      runs = resp && Array.isArray(resp.runs) ? resp.runs : [];
    } catch {
      // backend 暂时不可达：继续等（保持机器存活，让 scheduler 有机会跑）。
    }
    const match = runs.find(
      (r) => r.searchPlanVersionId === versionId && r.scheduledFor === scheduledFor,
    );
    if (match !== undefined && SOURCE_RUN_TERMINAL_STATUSES.includes(match.status)) {
      return { outcome: 'terminal', run: match };
    }
    await sleep(setTimeoutFn, Math.min(pollIntervalMs, Math.max(0, deadlineMs - now())));
  }
  return { outcome: 'timeout' };
}

// ── main（组合，测试 seam）──────────────────────────────────────────────────

export async function main({
  repoRoot = resolveRepoRoot(import.meta.url),
  nodeExecutable = process.execPath,
  launcherPath = path.join(repoRoot, 'scripts', 'autostart', 'offerflowAutostartLauncher.mjs'),
  healthUrl = HEALTH_URL,
  holdAwakeWindowMs = DEFAULT_HOLD_AWAKE_WINDOW_MS,
  recoverHealthWaitMs = RECOVER_HEALTH_WAIT_MS,
  occurrencePollIntervalMs = OCCURRENCE_POLL_INTERVAL_MS,
  fetchJson = defaultFetchJson(),
  spawnLauncherFn = defaultSpawnLauncher,
  readTaskConfiguredSchedule = defaultReadTaskConfiguredSchedule,
  now = Date.now,
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  chdirFn = (dir) => process.chdir(dir),
  existsSyncFn = (p) => fs.existsSync(p),
  mkdirSyncFn = (dir, opts) => fs.mkdirSync(dir, opts),
  writeLog = defaultWriteLog(repoRoot),
} = {}) {
  chdirFn(repoRoot);

  const log = (line) => writeLog(line);

  log('[wake-bridge] start');
  log(`  repoRoot=${repoRoot}`);

  if (!existsSyncFn(launcherPath)) {
    log(`[wake-bridge] launcher missing: ${launcherPath}`);
    return { exitCode: 1, reason: 'MISSING_LAUNCHER' };
  }

  mkdirSyncFn(path.dirname(path.join(repoRoot, 'logs', 'wake', 'placeholder.log')), { recursive: true });

  // 1) 健康检查：已健康 → 不启动第二个 backend。
  const health = await checkHealth({ fetchJson, healthUrl });
  if (!health.healthy) {
    log('[wake-bridge] backend unhealthy — recovering via launcher');
    spawnLauncherFn({ nodeExecutable, launcherPath, repoRoot });
    const recovered = await waitForHealthy({
      fetchJson,
      healthUrl,
      deadlineMs: now() + recoverHealthWaitMs,
      now,
      setTimeoutFn,
    });
    if (!recovered.healthy) {
      log('[wake-bridge] backend did not become healthy within recovery window');
    }
  } else {
    log('[wake-bridge] backend already healthy — not starting a second backend');
  }

  // 2) 读取 active plan；无 active plan / paused / deleted → 立即安全退出（不 hold、不 Run Now）。
  const occurrence = await resolveActiveOccurrence({ fetchJson, now });
  if (occurrence === null) {
    log('[wake-bridge] no active plan — EXIT_NO_ACTIVE_PLAN（不 hold / 不 Run Now / 不创建 SourceRun）');
    return { exitCode: 0, outcome: 'no_active_plan', reason: 'EXIT_NO_ACTIVE_PLAN' };
  }

  // 3) schedule drift 检测：bootstrap 时的 configuredDailyAt 与 active plan dailyAt 不一致 → 安全退出。
  const configuredSchedule = await readTaskConfiguredSchedule();
  if (configuredSchedule !== null && configuredSchedule.dailyAt !== occurrence.schedule.dailyAt) {
    log(`[wake-bridge] WAKE_TASK_STALE=YES configured=${configuredSchedule.dailyAt} active=${occurrence.schedule.dailyAt} — 不冒充 wake capability current`);
    return { exitCode: 0, outcome: 'wake_task_stale', reason: 'WAKE_TASK_STALE' };
  }

  log(`[wake-bridge] observing occurrence plan=${occurrence.planId} version=${occurrence.versionId} scheduledFor=${occurrence.scheduledFor}`);

  const result = await waitForOccurrence({
    fetchJson,
    planId: occurrence.planId,
    versionId: occurrence.versionId,
    scheduledFor: occurrence.scheduledFor,
    scheduledDay: occurrence.scheduledDay,
    pollIntervalMs: occurrencePollIntervalMs,
    deadlineMs: now() + holdAwakeWindowMs,
    now,
    setTimeoutFn,
  });

  log(`[wake-bridge] occurrence outcome=${result.outcome}`);
  return { exitCode: 0, outcome: result.outcome };
}

// ── 默认 side-effect 实现（生产环境，测试不触达）────────────────────────────

function defaultFetchJson() {
  return async (pathname, _opts) => {
    const response = await fetch(pathname.startsWith('http') ? pathname : `http://127.0.0.1:17365${pathname}`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`backend responded ${response.status}`);
    return response.json();
  };
}

function defaultSpawnLauncher({ nodeExecutable, launcherPath, repoRoot }) {
  const child = spawn(nodeExecutable, [launcherPath], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

/**
 * 只读探测自身 wake task 的 configured schedule（bootstrap 时写入 description 的安全 metadata）。
 * schtasks /Query /XML 只读，绝不 mutation；读不到 / 无 marker → null（无法判定 drift，bridge 按正常继续）。
 */
function defaultReadTaskConfiguredSchedule() {
  const result = spawnSync('schtasks.exe', buildQueryArgs({ taskName: WAKE_TASK_NAME }), { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const parsed = parseWakeTaskQueryXml(result.stdout);
  if (parsed === null) return null;
  return parseConfiguredScheduleFromDescription(parsed.description);
}

function defaultWriteLog(repoRoot) {
  const logDir = path.join(repoRoot, 'logs', 'wake');
  const logPath = path.join(logDir, `offerflow-wake-${composeLogFileName()}`);
  return (line) => {
    try {
      fs.appendFileSync(logPath, `${line}\n`, 'utf-8');
    } catch {
      // 日志写入失败不影响 bridge 行为。
    }
  };
}

// 仅作为直接入口执行时运行；被测试 import 时不自动运行。
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = await main();
  process.exitCode = result.exitCode;
}
