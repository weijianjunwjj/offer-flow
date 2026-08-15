/**
 * OfferFlow v0.9 — Windows Wake Layer 核心逻辑（纯函数，无 side effect）。
 *
 * 定位：HOST WAKE LAYER，不是第二套业务 Scheduler。
 *   - DailyJobScheduler = WHEN（业务调度）
 *   - DailyRunCoordinator = ONE RUN LIFECYCLE
 *   - PlanVersion.schedule = business source of truth
 *   - Windows Task Scheduler = 只负责「把机器从 S3 睡眠唤醒，并保持存活到 occurrence terminal」
 *
 * 本模块只包含「可单测的纯逻辑」：wake trigger 计算（dailyAt - WAKE_LEAD_TIME_MINUTES）、
 * Task Scheduler XML 定义（WakeToRun / StartWhenAvailable / battery flags / MultipleInstances）、
 * 命令构建（node + wake bridge，绝不含 cmd.exe / powershell.exe / secret）、schtasks 参数构造、
 * XML 解析与设置校验、enable / disable / status 子命令编排。
 *
 * 绝不触碰真实 schtasks.exe、真实 Task Scheduler、真实文件系统、真实 fetch。
 * 这些 side effect 由 windowsWakeTask.mjs / server 侧 adapter 注入。
 * 绝不把 secret 写入任何 command、XML、日志或 env 值。
 */

import { isWindowsPlatform } from './autostartCore.mjs';

// ── 冻结常量 ─────────────────────────────────────────────────────────────────

/** 权威 wake task 名称（与 HKCU Run 的 OfferFlowDailyJobHunter 区分：这是唤醒层，不是登录自启动）。 */
export const WAKE_TASK_NAME = 'OfferFlowDailyJobHunterWake';

/** 唤醒提前量：wake trigger = dailyAt - 2 分钟（给 backend 留出恢复与 occurrence 创建的时间）。 */
export const WAKE_LEAD_TIME_MINUTES = 2;

/** wake bridge 默认保持存活窗口（08:58 → 09:08 左右），有界，不无限等待。 */
export const DEFAULT_HOLD_AWAKE_WINDOW_MS = 10 * 60 * 1000;

/** Task Scheduler 执行时限（略大于 hold-awake 窗口 + 恢复开销，保证 bridge 能跑满窗口）。 */
export const WAKE_TASK_EXECUTION_TIME_LIMIT = 'PT15M';

/** 后端健康检查地址（与 server/index.ts 的 /health 一致）。 */
export const HEALTH_URL = 'http://127.0.0.1:17365/health';

/** 健康检查单次超时。 */
export const HEALTH_TIMEOUT_MS = 2000;

/** 恢复 backend 后等待其健康的 bounded 上限。 */
export const RECOVER_HEALTH_WAIT_MS = 60 * 1000;

/** occurrence 观测轮询间隔。 */
export const OCCURRENCE_POLL_INTERVAL_MS = 5000;

/** SourceRun 终态集合（与 server/source-run/types.ts SOURCE_RUN_TERMINAL_STATUSES 一致）。 */
export const SOURCE_RUN_TERMINAL_STATUSES = [
  'PARTIALLY_SUCCEEDED',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'INTERRUPTED',
];

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── Schedule / Wake trigger 计算 ────────────────────────────────────────────

/** 校验 dailyAt（严格 HH:mm）。 */
export function isValidDailyAt(dailyAt) {
  return typeof dailyAt === 'string' && DAILY_AT_RE.test(dailyAt);
}

/**
 * 从 PlanVersion.schedule（或后端 API 返回的 activeVersion.schedule）解析出 { dailyAt, timezone }。
 * timezone 缺省按 v0.9 决策补 Asia/Shanghai；dailyAt 非法抛错。
 */
export function parseWakeSchedule(schedule) {
  if (schedule === null || typeof schedule !== 'object') {
    throw new Error('schedule 必须是对象');
  }
  const dailyAt = typeof schedule.dailyAt === 'string' ? schedule.dailyAt : '';
  const timezone = typeof schedule.timezone === 'string' && schedule.timezone !== ''
    ? schedule.timezone
    : 'Asia/Shanghai';
  if (!isValidDailyAt(dailyAt)) {
    throw new Error(`schedule.dailyAt 非法（需 HH:mm）: ${dailyAt}`);
  }
  return { dailyAt, timezone };
}

/**
 * 计算 wake wall-clock "HH:mm" = dailyAt - leadMinutes，跨午夜安全回绕。
 * 例：dailyAt=09:00 → 08:58；dailyAt=00:00 → 23:58（前一日）。
 */
export function computeWakeTime(dailyAt, leadMinutes) {
  if (!isValidDailyAt(dailyAt)) {
    throw new Error(`schedule.dailyAt 非法（需 HH:mm）: ${dailyAt}`);
  }
  const [h, m] = dailyAt.split(':').map((s) => Number(s));
  const total = h * 60 + m - leadMinutes;
  const dayMinutes = 24 * 60;
  const wrapped = ((total % dayMinutes) + dayMinutes) % dayMinutes;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * 计算下一次 wake trigger 的 StartBoundary（本地时间，无时区偏移）。
 * 语义：v0.9 officially supported timezone = Asia/Shanghai（无 DST），且生产机器 host 时区与之一致，
 * 因此用 host 本地时间直接表达 wake wall-clock；不再引入第三方 timezone dependency 或 DST 泛化。
 * 若今天 wake 时刻已过，则取明天。
 */
export function computeNextWakeStartBoundary({ dailyAt, leadMinutes, now }) {
  const wakeHm = computeWakeTime(dailyAt, leadMinutes);
  const [h, m] = wakeHm.split(':').map((s) => Number(s));
  const d = new Date(now);
  const todayWake = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  const target = todayWake > now ? todayWake : todayWake + 24 * 60 * 60 * 1000;
  return localStartBoundary(target);
}

/** 把 epoch ms 转成 Task Scheduler 本地 StartBoundary "YYYY-MM-DDTHH:mm:ss"（host 本地时间）。 */
export function localStartBoundary(instant) {
  const t = new Date(instant);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
}

// ── Wake task command / XML ─────────────────────────────────────────────────

/** 构建 wake task 命令文本：`"<node.exe>" "<wakeBridge.mjs>"`（仅两个 token，绝不含 secret）。 */
export function buildWakeTaskCommand({ nodeExecutable, wakeBridgePath }) {
  return `"${nodeExecutable}" "${wakeBridgePath}"`;
}

/**
 * 构建 Task Scheduler 2.0 XML（daily CalendarTrigger + 全部冻结 settings）。
 * 关键冻结项（PHASE 5/6/7/8）：
 *   - WakeToRun = true（本功能核心，机器从 S3 唤醒）
 *   - StartWhenAvailable = false（不建第二套 missed-run recovery，catch-up 仍归 DailyJobScheduler）
 *   - DisallowStartIfOnBatteries = false / StopIfGoingOnBatteries = false（保证笔记本未接 AC 也能唤醒）
 *   - MultipleInstancesPolicy = IgnoreNew（避免已有 wake bridge 运行时再起第二实例）
 *
 * command/arguments 只含 node executable + wake bridge 路径，绝不含 cmd.exe / powershell.exe / secret。
 */
export function buildWakeTaskXml({
  taskName,
  description,
  nodeExecutable,
  wakeBridgePath,
  workingDirectory,
  startBoundary,
  executionTimeLimit = WAKE_TASK_EXECUTION_TIME_LIMIT,
}) {
  const escapedDescription = String(description).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapedDescription}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>${executionTimeLimit}</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${nodeExecutable}</Command>
      <Arguments>"${wakeBridgePath}"</Arguments>
      <WorkingDirectory>${workingDirectory}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** 生成固定、无 secret 的 wake task 描述文本（含 timezone 便于观测）。 */
export function buildWakeTaskDescription({ timezone }) {
  return `OfferFlow v0.9 Windows wake task (${timezone}) — wakes host from S3 sleep so DailyJobScheduler creates the daily SCHEDULED occurrence. Not a business scheduler.`;
}

// ── schtasks 参数构造 ───────────────────────────────────────────────────────

/** `schtasks /Create /TN <name> /XML <file> /F` —— 从 XML 完整注册（含 WakeToRun 等设置）。 */
export function buildCreateArgs({ taskName, xmlFilePath }) {
  return ['/Create', '/TN', taskName, '/XML', xmlFilePath, '/F'];
}

/** `schtasks /Delete /TN <name> /F` —— 只删自身 wake task，绝不触碰其它任务。 */
export function buildDeleteArgs({ taskName }) {
  return ['/Delete', '/TN', taskName, '/F'];
}

/** `schtasks /Query /TN <name> /XML` —— 只读探测，取回完整 XML 以便校验设置。 */
export function buildQueryArgs({ taskName }) {
  return ['/Query', '/TN', taskName, '/XML'];
}

// ── schtasks /Query /XML 解析与设置校验 ────────────────────────────────────

/** 提取 XML 中单个元素文本（schtasks /Query /XML 输出为受控 Task Scheduler XML）。 */
function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, 's'));
  return match === null ? null : match[1];
}

function readXmlBool(xml, tag) {
  const value = readXmlTag(xml, tag);
  return value === null ? null : value.trim().toLowerCase() === 'true';
}

/**
 * 解析 schtasks /Query /XML 的 stdout，返回结构化 task 状态。
 * 输出为空 / 无 <Task> 根节点 → null（表示任务不存在 / disabled）。
 */
export function parseWakeTaskQueryXml(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  const xml = stdout;
  if (!/<Task\b/i.test(xml)) return null;
  const command = readXmlTag(xml, 'Command');
  const argumentsValue = readXmlTag(xml, 'Arguments');
  const startBoundary = readXmlTag(xml, 'StartBoundary');
  if (command === null) return null;
  return {
    command,
    arguments: argumentsValue ?? '',
    startBoundary,
    wakeToRun: readXmlBool(xml, 'WakeToRun'),
    startWhenAvailable: readXmlBool(xml, 'StartWhenAvailable'),
    multipleInstancesPolicy: readXmlTag(xml, 'MultipleInstancesPolicy'),
    disallowStartIfOnBatteries: readXmlBool(xml, 'DisallowStartIfOnBatteries'),
    stopIfGoingOnBatteries: readXmlBool(xml, 'StopIfGoingOnBatteries'),
  };
}

/** 判定 task command 是否安全：不含 cmd.exe / powershell.exe / secret。 */
export function isWakeTaskCommandSafe(parsed) {
  if (parsed === null) return true; // 不存在即无风险
  const text = `${parsed.command}\n${parsed.arguments}`.toLowerCase();
  if (text.includes('cmd.exe') || text.includes('powershell.exe') || text.includes('pwsh')) return false;
  return !/TAVILY|DEEPSEEK|API_KEY|SECRET|PASSWORD|Bearer/i.test(text);
}

/**
 * 校验已注册 task 的冻结设置是否全部符合期望。
 * 返回 { allVerified, commandSafe, wakeToRun, startWhenAvailable, multipleInstancesPolicy, batteryFlags }。
 */
export function verifyWakeTaskSettings(parsed) {
  if (parsed === null) {
    return {
      allVerified: false,
      commandSafe: true,
      wakeToRun: false,
      startWhenAvailable: null,
      multipleInstancesPolicy: null,
      batteryFlags: null,
    };
  }
  const wakeToRun = parsed.wakeToRun === true;
  const startWhenAvailable = parsed.startWhenAvailable === false;
  const multipleInstancesPolicy = parsed.multipleInstancesPolicy === 'IgnoreNew';
  const batteryFlags = parsed.disallowStartIfOnBatteries === false && parsed.stopIfGoingOnBatteries === false;
  const commandSafe = isWakeTaskCommandSafe(parsed);
  return {
    allVerified: wakeToRun && startWhenAvailable && multipleInstancesPolicy && batteryFlags && commandSafe,
    commandSafe,
    wakeToRun,
    startWhenAvailable,
    multipleInstancesPolicy,
    batteryFlags,
  };
}

/** 比较 task 已注册 command 与当前 repo 期望值，判定是否 stale（repo 移动 / node 变化）。 */
export function detectWakeTaskStale(parsed, { nodeExecutable, wakeBridgePath }) {
  if (parsed === null) return false; // 不存在不叫 stale，叫 absent
  const currentArguments = parsed.arguments.replace(/^"|"$/g, '');
  return parsed.command !== nodeExecutable || currentArguments !== wakeBridgePath;
}

// ── enable / disable / status 子命令编排 ───────────────────────────────────

/**
 * 执行 wake-task 子命令（enable / disable / status），返回结构化结果。
 * 全部 side effect 通过 deps 注入：schtasksExecutor（真实实现调用 schtasks.exe）、
 * writeXmlFile / removeXmlFile（真实实现写/删临时 XML）、fetchJson（真实实现用 global fetch 读后端 active schedule）。
 *
 * enable 必须从后端 active PlanVersion.schedule 取 dailyAt（绝不硬编码 09:00 作为产品常量）。
 */
export async function runWakeTaskCommand(argv, deps) {
  const {
    platform,
    nodeExecutable,
    wakeBridgePath,
    workingDirectory,
    schtasksExecutor,
    writeXmlFile,
    removeXmlFile,
    fetchJson,
    now = Date.now,
  } = deps;
  const subcommand = argv[0];

  if (!isWindowsPlatform(platform)) {
    return { ok: false, code: 1, subcommand, reason: 'NON_WINDOWS' };
  }

  if (subcommand === 'enable') {
    const resolved = await resolveWakeScheduleFromBackend(fetchJson);
    if (resolved === null) {
      return { ok: false, code: 1, subcommand, reason: 'NO_ACTIVE_PLAN', taskName: WAKE_TASK_NAME };
    }
    const { dailyAt, timezone } = resolved;
    const wakeAt = computeWakeTime(dailyAt, WAKE_LEAD_TIME_MINUTES);
    const startBoundary = computeNextWakeStartBoundary({
      dailyAt,
      leadMinutes: WAKE_LEAD_TIME_MINUTES,
      now: now(),
    });
    const command = buildWakeTaskCommand({ nodeExecutable, wakeBridgePath });
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: buildWakeTaskDescription({ timezone }),
      nodeExecutable,
      wakeBridgePath,
      workingDirectory,
      startBoundary,
    });
    const xmlFilePath = writeXmlFile(xml);
    const createArgs = buildCreateArgs({ taskName: WAKE_TASK_NAME, xmlFilePath });
    const result = schtasksExecutor(createArgs);
    try {
      removeXmlFile(xmlFilePath);
    } catch {
      // 临时 XML 清理失败不影响任务注册结果。
    }
    if (result.status !== 0) {
      return {
        ok: false,
        code: 1,
        subcommand,
        reason: 'SCHTASKS_ERROR',
        stderr: result.stderr ?? '',
        taskName: WAKE_TASK_NAME,
      };
    }
    return {
      ok: true,
      code: 0,
      subcommand,
      taskName: WAKE_TASK_NAME,
      command,
      wakeAt,
      startBoundary,
      dailyAt,
      timezone,
      xml,
      schtasksArgs: createArgs,
    };
  }

  if (subcommand === 'disable') {
    const deleteArgs = buildDeleteArgs({ taskName: WAKE_TASK_NAME });
    const result = schtasksExecutor(deleteArgs);
    // 幂等：任务不存在也算成功（schtasks /Delete 对不存在任务返回非零）。
    return {
      ok: true,
      code: 0,
      subcommand,
      taskName: WAKE_TASK_NAME,
      schtasksArgs: deleteArgs,
      existed: result.status === 0,
    };
  }

  if (subcommand === 'status') {
    const queryArgs = buildQueryArgs({ taskName: WAKE_TASK_NAME });
    const result = schtasksExecutor(queryArgs);
    if (result.status !== 0) {
      return { ok: true, code: 0, subcommand, taskName: WAKE_TASK_NAME, status: 'absent', schtasksArgs: queryArgs };
    }
    const parsed = parseWakeTaskQueryXml(result.stdout);
    if (parsed === null) {
      return { ok: true, code: 0, subcommand, taskName: WAKE_TASK_NAME, status: 'absent', schtasksArgs: queryArgs };
    }
    const settings = verifyWakeTaskSettings(parsed);
    const stale = detectWakeTaskStale(parsed, { nodeExecutable, wakeBridgePath });
    return {
      ok: true,
      code: 0,
      subcommand,
      taskName: WAKE_TASK_NAME,
      status: 'registered',
      command: parsed.command,
      arguments: parsed.arguments,
      startBoundary: parsed.startBoundary,
      settings,
      stale,
      schtasksArgs: queryArgs,
    };
  }

  return { ok: false, code: 2, subcommand, reason: 'UNKNOWN_COMMAND' };
}

/**
 * 从后端 HTTP API 解析「第一个 active plan 的 activeVersion.schedule」。
 * 返回 { dailyAt, timezone } 或 null（无 active plan / 后端不可用 / schedule 非法）。
 * fetchJson 注入，测试用 fake 替换。
 */
export async function resolveWakeScheduleFromBackend(fetchJson) {
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
  const activeVersion = detail && detail.activeVersion ? detail.activeVersion : null;
  if (activeVersion === null || activeVersion.schedule === undefined) return null;
  try {
    return parseWakeSchedule(activeVersion.schedule);
  } catch {
    return null;
  }
}
