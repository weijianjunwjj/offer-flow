/**
 * OfferFlow v0.9 — Windows Wake Layer 核心逻辑（纯函数，无 side effect）。
 *
 * 定位：HOST WAKE LAYER，不是第二套业务 Scheduler。
 *   - DailyJobScheduler = WHEN（业务调度）
 *   - DailyRunCoordinator = ONE RUN LIFECYCLE
 *   - PlanVersion.schedule = business source of truth
 *   - Windows Task Scheduler = 只负责「把机器从 S3 睡眠唤醒，并短暂保持存活」
 *
 * v0.9 Wake Admin-Bootstrap 架构冻结（PRIVILEGE BOUNDARY HARDENING）：
 *   - Windows wake task 是 PRIVILEGED BOOTSTRAP ARTIFACT（由提权 CLI enable 创建/覆盖）。
 *   - 普通 OfferFlow backend 绝不 mutation Windows Task Scheduler（WAKE_TASK_MUTATION_FROM_SERVER=FORBIDDEN）。
 *   - 本机当前 Windows 用户是 Builtin Administrator：Task Scheduler 会忽略 RunLevel，task action 实际 elevated。
 *     因此 task action 的 trust boundary 必须收敛为 WINDOWS_SYSTEM32_ONLY：
 *     唯一允许的 action = C:\Windows\System32\ping.exe + 有界 hold 参数（约 5 分钟）。
 *     绝不使用 node.exe / repo script / cmd.exe / powershell.exe（这些是 user-writable / 可提权路径）。
 *   - Wake Task 与 OfferFlow runtime 彻底解耦：不启动 backend、不读 Plan、不调用 HTTP / Run Now、不观测 SourceRun。
 *   - 只有 OS wake trigger 时间本身变化（dailyAt 变化）才需要重新提权 bootstrap。
 *
 * 本模块只包含「可单测的纯逻辑」：wake trigger 计算（dailyAt - WAKE_LEAD_TIME_MINUTES）、
 * Task Scheduler XML 定义（WakeToRun / StartWhenAvailable / battery flags / MultipleInstances）、
 * 受信 action 构建（System32 ping.exe + 有界 hold）、schtasks 参数构造、
 * 配置持久化（configuredDailyAt / timezone / wakeLeadMinutes 写入 description 安全 metadata）、
 * schedule drift 检测、XML 解析与 STALE_REASON_CODES 计算、enable / disable / status 子命令编排（含提权门禁）。
 *
 * 绝不触碰真实 schtasks.exe、真实 Task Scheduler、真实文件系统、真实 fetch。
 * 这些 side effect 由 windowsWakeTask.mjs 注入。
 * 绝不把 secret 写入任何 command、XML、日志或 env 值。
 */

import path from 'node:path';
import { isWindowsPlatform } from './autostartCore.mjs';

// ── 冻结常量 ─────────────────────────────────────────────────────────────────

/** 权威 wake task 名称（与 HKCU Run 的 OfferFlowDailyJobHunter 区分：这是唤醒层，不是登录自启动）。 */
export const WAKE_TASK_NAME = 'OfferFlowDailyJobHunterWake';

/** 唤醒提前量：wake trigger = dailyAt - 2 分钟（给 backend 留出恢复与 occurrence 创建的时间）。 */
export const WAKE_LEAD_TIME_MINUTES = 2;

/**
 * 有界 hold 的 ping 次数：ping /n 301 ≈ 300 秒 ≈ 5 分钟。bounded，绝不无限运行。
 * 注意：Microsoft 文档只定义 /n <count> 为 echo request 数量，不承诺 count == seconds。
 * 该等价关系已通过本机 wall-clock probe 实测验证（/n 6 → 约 5s，/n 11 → 约 10s），
 * 故 /n 301 对应约 300 秒的 hold 窗口。绝不依赖未经验证的「count 必然等于秒数」推论。
 */
export const WAKE_HOLD_PING_COUNT = 301;

/** 有界 hold 时长（5 分钟，供文档/验收口径，实际由 ping /n 次数控制）。 */
export const WAKE_HOLD_DURATION_MS = 5 * 60 * 1000;

/**
 * 唯一允许的 task action executable：Windows 受保护 System32 目录中的系统自带 ping.exe。
 * 绝不使用 node.exe / repo script / cmd.exe / powershell.exe —— 它们是 user-writable / 可提权路径。
 */
export const TRUSTED_HOLD_EXECUTABLE = 'C:\\Windows\\System32\\ping.exe';

/**
 * 有界 hold 参数（官方参数形式）：ping /n 301 127.0.0.1，仅让 task process 存活以保持机器 awake。
 * 采用 Microsoft 文档定义的 /n <count>（echo request 数量）形式，target 放在最后。
 * 绝不使用未经验证的 -n 位置/语义变体，也绝不引入 shell 包装或额外解释层。
 */
export const TRUSTED_HOLD_ARGUMENTS = `/n ${WAKE_HOLD_PING_COUNT} 127.0.0.1`;

/** Task Scheduler 执行时限（第二层保护，略大于 hold 窗口，绝不无限运行）。 */
export const WAKE_TASK_EXECUTION_TIME_LIMIT = 'PT15M';

/**
 * 架构冻结标记：普通 OfferFlow backend runtime 禁止 mutation Windows Task Scheduler。
 * wake task 是管理员引导产物，schedule 变化只能通过提权 CLI（wake-task:enable）reconcile。
 */
export const WAKE_TASK_MUTATION_FROM_SERVER = 'FORBIDDEN';

/**
 * 新的安全验收口径（Builtin Administrator 会忽略 RunLevel，task 实际 elevated）：
 *   - TASK_EXECUTION_MAY_BE_ELEVATED = YES（当前账户为 Builtin Administrator，无法成立 LeastPrivilege）
 *   - TASK_ACTION_TRUST_BOUNDARY = WINDOWS_SYSTEM32_ONLY（action 只能位于 System32）
 *   - USER_WRITABLE_CODE_EXECUTED = NO（绝不执行 node.exe / repo script / 用户目录可写代码）
 */
export const TASK_EXECUTION_MAY_BE_ELEVATED = 'YES';
export const TASK_ACTION_TRUST_BOUNDARY = 'WINDOWS_SYSTEM32_ONLY';
export const USER_WRITABLE_CODE_EXECUTED = 'NO';

/** description 中机器可解析配置的 marker（bootstrap 时写入，status 读回比较）。 */
const WAKE_CONFIG_MARKER = 'offerflow-wake-config:';

const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// ── Windows 提权检测（纯解析，无 side effect） ────────────────────────────────

/** Windows integrity SID 常量（只按 SID 判定，绝不解析本地化组名 / "Administrator" 文本）。 */
export const INTEGRITY_SID_HIGH = 'S-1-16-12288';   // High Mandatory Level
export const INTEGRITY_SID_SYSTEM = 'S-1-16-16384'; // System Mandatory Level
export const INTEGRITY_SID_MEDIUM = 'S-1-16-8192';  // Medium Mandatory Level

/** 提权检测三态结果（check-failed 绝不默认 elevated）。 */
export const ELEVATION_ELEVATED = 'elevated';
export const ELEVATION_NOT_ELEVATED = 'not-elevated';
export const ELEVATION_CHECK_FAILED = 'check-failed';

/**
 * 解析 `whoami.exe /groups /fo csv /nh` 的 stdout，只按 integrity SID 判定提权状态。
 * 出现 High（S-1-16-12288）或更高（System S-1-16-16384）→ elevated；
 * 出现 Medium（S-1-16-8192）→ not-elevated；
 * 无任何 integrity SID / 空输出 → check-failed。
 * 只依赖 ASCII SID，即使中文/乱码组名编码错乱仍可正确判定。
 */
export function parseElevationOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return ELEVATION_CHECK_FAILED;
  if (stdout.includes(INTEGRITY_SID_SYSTEM) || stdout.includes(INTEGRITY_SID_HIGH)) {
    return ELEVATION_ELEVATED;
  }
  if (stdout.includes(INTEGRITY_SID_MEDIUM)) {
    return ELEVATION_NOT_ELEVATED;
  }
  return ELEVATION_CHECK_FAILED;
}

/**
 * 解析 Windows 原生 whoami.exe 的绝对路径（%SystemRoot%\System32\whoami.exe）。
 * 绝不返回裸 'whoami.exe'，避免落到 Git Bash PATH 里的 GNU coreutils whoami（它不支持 /groups）。
 */
export function resolveWindowsWhoamiPath(systemRoot) {
  return path.join(systemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
}

/**
 * 执行提权检测（spawnSyncFn 注入，真实实现为 node:child_process.spawnSync）。
 * 用显式 System32 whoami.exe 路径 + `/groups /fo csv /nh`，shell=false，不经 shell。
 * 任何 spawn error / non-zero exit / 无法解析 → check-failed，绝不默认 elevated。
 */
export function detectElevation({ whoamiPath, spawnSyncFn }) {
  let result;
  try {
    result = spawnSyncFn(whoamiPath, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf-8', shell: false });
  } catch {
    return ELEVATION_CHECK_FAILED;
  }
  if (!result || result.error || result.status !== 0) return ELEVATION_CHECK_FAILED;
  return parseElevationOutput(result.stdout ?? '');
}

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

// ── 受信 action（System32-only） ────────────────────────────────────────────

/**
 * 解析 System32 目录下 ping.exe 的绝对路径（唯一允许的 task action executable）。
 * 绝不返回裸 'ping.exe'（避免落到 PATH 中用户可写的同名文件）。
 */
export function resolveTrustedHoldExecutable(systemRoot) {
  return path.join(systemRoot || 'C:\\Windows', 'System32', 'ping.exe');
}

/**
 * 判定 task command 是否为受信 System32 ping.exe（大小写/斜杠不敏感，绝对路径精确匹配）。
 * 这是 task action trust boundary 的核心检查：绝不放行裸 ping.exe / 用户目录 / node.exe / 任何脚本。
 */
export function isTrustedSystem32Ping(command, systemRoot = 'C:\\Windows') {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const norm = (p) => p.replace(/\//g, '\\').toLowerCase();
  return norm(command) === norm(path.join(systemRoot, 'System32', 'ping.exe'));
}

/** 判定 task arguments 是否为有界 hold 参数（/n <bounded-count> 127.0.0.1，空白/大小写不敏感）。 */
export function isTrustedHoldArguments(argumentsText) {
  const norm = (s) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(argumentsText) === norm(TRUSTED_HOLD_ARGUMENTS);
}

// ── Wake task XML ───────────────────────────────────────────────────────────

/**
 * 构建 Task Scheduler 2.0 XML（daily CalendarTrigger + 全部冻结 settings）。
 * 关键冻结项：
 *   - WakeToRun = true（本功能核心，机器从 S3 唤醒）
 *   - StartWhenAvailable = false（不建第二套 missed-run recovery，catch-up 仍归 DailyJobScheduler）
 *   - DisallowStartIfOnBatteries = false / StopIfGoingOnBatteries = false（保证笔记本未接 AC 也能唤醒）
 *   - MultipleInstancesPolicy = IgnoreNew（避免已有 hold task 运行时再起第二实例）
 *
 * action trust boundary（PRIVILEGE BOUNDARY HARDENING）：
 *   command = System32 ping.exe，arguments = 有界 hold 参数，绝不引用 node.exe / repo script / cmd.exe / powershell.exe。
 *   RunLevel 仍写 LeastPrivilege 作为非管理员账户的「最小权限意图」，但 Builtin Administrator 会忽略它；
 *   真正的安全保证是 action 收敛为 System32-only（见 TASK_ACTION_TRUST_BOUNDARY）。
 */
export function buildWakeTaskXml({
  taskName,
  description,
  command,
  arguments: argumentsText,
  workingDirectory,
  startBoundary,
  executionTimeLimit = WAKE_TASK_EXECUTION_TIME_LIMIT,
}) {
  const escapedDescription = String(description).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-16"?>
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
      <Command>${command}</Command>
      <Arguments>${argumentsText}</Arguments>
      <WorkingDirectory>${workingDirectory}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * 把 Task Scheduler XML 编码为 Windows `schtasks /Create /XML` 可接受的实际字节流。
 *
 * 冻结契约（v0.9）：declaration 与实际字节编码必须一致，否则 schtasks import 报
 * "unable to switch encoding"（真实 elevated import 已复现，见 TASK_XML_ENCODING_IMPORT_COMPATIBILITY_BUG）。
 * 正式 contract = UTF-16LE + BOM：
 *   - 前两字节 0xFF 0xFE（UTF-16LE BOM）
 *   - 后续为 xml 的 UTF-16LE 编码
 *   - xml 内 declaration 固定为 encoding="UTF-16"
 *
 * 绝不使用 `writeFileSync(path, xml, 'utf-8')` 写入 Task XML —— 那会产出 UTF-8 字节 +
 * UTF-16 declaration，正是本 bug 的根因。返回 Buffer，由 windowsWakeTask.mjs 唯一写盘。
 */
export function encodeTaskXmlForWindows(xml) {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(xml, 'utf16le'),
  ]);
}

/**
 * 生成固定、无 secret 的 wake task 描述文本，并把 bootstrap 时的 configured schedule 持久化为
 * 可解析的安全 metadata（只含 dailyAt / timezone / wakeLeadMinutes，绝不含 secret）。
 * status 每次读回该 metadata，与当前 active PlanVersion schedule 比较以检测 drift。
 */
export function buildWakeTaskDescription({ dailyAt, timezone, wakeLeadMinutes = WAKE_LEAD_TIME_MINUTES }) {
  return `OfferFlow v0.9 Windows wake task (${timezone}) — host-wake only: wakes the machine from S3 sleep and holds it awake briefly so the long-running backend's DailyJobScheduler creates the daily SCHEDULED occurrence. Does not execute OfferFlow code. [${WAKE_CONFIG_MARKER} dailyAt=${dailyAt}; timezone=${timezone}; wakeLeadMinutes=${wakeLeadMinutes}]`;
}

/**
 * 从 task description 解析 bootstrap 时持久化的 configured schedule。
 * 无 marker / dailyAt 非法 → null（表示旧 task 或非本工具注册，无法判定 drift）。
 */
export function parseConfiguredScheduleFromDescription(description) {
  if (typeof description !== 'string') return null;
  const idx = description.indexOf(WAKE_CONFIG_MARKER);
  if (idx < 0) return null;
  const rest = description.slice(idx + WAKE_CONFIG_MARKER.length);
  const close = rest.indexOf(']');
  const body = close >= 0 ? rest.slice(0, close) : rest;
  const map = {};
  for (const pair of body.split(';').map((s) => s.trim()).filter((s) => s !== '')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  if (typeof map.dailyAt !== 'string' || !isValidDailyAt(map.dailyAt)) return null;
  const timezone = typeof map.timezone === 'string' && map.timezone !== ''
    ? map.timezone
    : 'Asia/Shanghai';
  const wakeLeadMinutes = typeof map.wakeLeadMinutes === 'string' && /^\d+$/.test(map.wakeLeadMinutes)
    ? Number(map.wakeLeadMinutes)
    : WAKE_LEAD_TIME_MINUTES;
  return { dailyAt: map.dailyAt, timezone, wakeLeadMinutes };
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

// ── schtasks /Query /XML 解析与 STALE_REASON_CODES 计算 ──────────────────────

/** 提取 XML 中单个元素文本（schtasks /Query /XML 输出为受控 Task Scheduler XML）。 */
function readXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>\\s*(.*?)\\s*</${tag}>`, 's'));
  return match === null ? null : match[1];
}

/**
 * 读取 XML boolean 元素。defaultValue 必须按 Microsoft Task Scheduler schema 各自的默认值传入，
 * 绝不把所有 missing boolean 统一解释成 false。冻结 schema default：
 *   - StartWhenAvailable = false
 *   - DisallowStartIfOnBatteries = true
 *   - StopIfGoingOnBatteries = true
 * schtasks /Query /XML 的 canonical readback 会省略等于默认值的元素；缺失时应还原为 schema 默认值，
 * 而不是臆断为 false。因此 battery flags 缺失 → true → 与正式契约 false 不符 → BATTERY_POLICY_MISMATCH。
 */
function readXmlBool(xml, tag, defaultValue = null) {
  const value = readXmlTag(xml, tag);
  if (value === null) return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

/**
 * 解析 schtasks /Query /XML 的 stdout，返回结构化 task 状态。
 * 输出为空 / 无 <Task> 根节点 → null（表示任务不存在 / disabled）。
 *
 * 规范化要点（冻结 Task Scheduler schema 默认值）：
 *   - StartWhenAvailable 缺省 → false（schema default = false）。
 *   - MultipleInstancesPolicy 缺省 → IgnoreNew（schema default = IgnoreNew）。
 *   - DisallowStartIfOnBatteries 缺省 → true（schema default = true）。
 *   - StopIfGoingOnBatteries 缺省 → true（schema default = true）。
 *   - RunLevel 可能被省略（Builtin Administrator 会忽略 RunLevel）→ 单独保留为 null，不参与 stale 判定。
 *
 * 历史 stale 根因澄清（不得再写成 battery flags）：
 *   旧 task 的 canonical XML 显式包含 <DisallowStartIfOnBatteries>false</...> 与
 *   <StopIfGoingOnBatteries>false</...>，battery flags 并未缺失。真正被省略的是 StartWhenAvailable，
 *   旧 parser 将 missing → null，而期望是 false，从而误报 START_WHEN_AVAILABLE_MISMATCH。
 *   正确根因 = START_WHEN_AVAILABLE_DEFAULT_FALSE_NOT_APPLIED。
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
    description: readXmlTag(xml, 'Description') ?? '',
    startBoundary,
    logonType: readXmlTag(xml, 'LogonType'),
    runLevel: readXmlTag(xml, 'RunLevel'),
    userId: readXmlTag(xml, 'UserId'),
    wakeToRun: readXmlBool(xml, 'WakeToRun'),
    startWhenAvailable: readXmlBool(xml, 'StartWhenAvailable', false),
    multipleInstancesPolicy: readXmlTag(xml, 'MultipleInstancesPolicy') ?? 'IgnoreNew',
    disallowStartIfOnBatteries: readXmlBool(xml, 'DisallowStartIfOnBatteries', true),
    stopIfGoingOnBatteries: readXmlBool(xml, 'StopIfGoingOnBatteries', true),
  };
}

/**
 * 计算 task contract 与冻结期望之间的 mismatch reason codes（静态部分，不含 schedule drift）。
 * 返回空数组 = 静态 contract current。
 * 支持的最小 reason code 集（PHASE 10）：
 *   COMMAND_MISMATCH / ARGUMENTS_MISMATCH / WAKE_TO_RUN_MISMATCH / START_WHEN_AVAILABLE_MISMATCH /
 *   MULTIPLE_INSTANCE_MISMATCH / BATTERY_POLICY_MISMATCH / PRINCIPAL_MISMATCH。
 * 注意：PRINCIPAL 只比较 LogonType（InteractiveToken）；RunLevel 不参与（Builtin Administrator 会省略它）。
 */
export function computeWakeTaskMismatches(parsed, { systemRoot = 'C:\\Windows' } = {}) {
  if (parsed === null) return [];
  const reasons = [];
  if (!isTrustedSystem32Ping(parsed.command, systemRoot)) reasons.push('COMMAND_MISMATCH');
  if (!isTrustedHoldArguments(parsed.arguments)) reasons.push('ARGUMENTS_MISMATCH');
  if (parsed.wakeToRun !== true) reasons.push('WAKE_TO_RUN_MISMATCH');
  if (parsed.startWhenAvailable !== false) reasons.push('START_WHEN_AVAILABLE_MISMATCH');
  if (parsed.multipleInstancesPolicy !== 'IgnoreNew') reasons.push('MULTIPLE_INSTANCE_MISMATCH');
  if (!(parsed.disallowStartIfOnBatteries === false && parsed.stopIfGoingOnBatteries === false)) {
    reasons.push('BATTERY_POLICY_MISMATCH');
  }
  if (parsed.logonType !== 'InteractiveToken') reasons.push('PRINCIPAL_MISMATCH');
  return reasons;
}

/**
 * schedule drift 检测：bootstrap 时持久化的 configured dailyAt 与当前 active plan dailyAt 是否一致。
 * 只有 OS wake trigger 时间本身变化（dailyAt 变化）才算 drift —— pause / resume / no active plan 不算。
 */
export function detectScheduleDrift(parsed, activeDailyAt) {
  if (parsed === null) return false;
  const configured = parseConfiguredScheduleFromDescription(parsed.description);
  if (configured === null) return false; // 无配置 marker 无法判定（status 层会据此标 stale）
  return configured.dailyAt !== activeDailyAt;
}

// ── enable / disable / status 子命令编排 ───────────────────────────────────

/**
 * 执行 wake-task 子命令（enable / disable / status），返回结构化结果。
 * 全部 side effect 通过 deps 注入：schtasksExecutor（真实实现调用 schtasks.exe）、
 * writeXmlFile / removeXmlFile（真实实现写/删临时 XML）、fetchJson（真实实现用 global fetch 读后端 active schedule）、
 * isElevated（真实实现用显式 System32 whoami.exe /groups 检测 integrity SID，返回三态）。
 *
 * 提权门禁：enable / disable 是 PRIVILEGED INSTALL / UNINSTALL。三态：
 *   - check-failed → ELEVATION_CHECK_FAILED（无法检测，绝不默认 elevated）
 *   - not-elevated → ELEVATION_REQUIRED
 *   - elevated → 才进入 schtasks /Create /Delete
 * 绝不调用 schtasks mutation；status 是 READ ONLY，普通用户可运行。
 *
 * enable 必须从后端 active PlanVersion.schedule 取 dailyAt（绝不硬编码 09:00 作为产品常量），
 * 并把 configured schedule 持久化进 task description（供 status 做 drift 检测）。
 * action 固定为 System32 ping.exe + 有界 hold 参数（trust boundary），与 OfferFlow runtime 完全解耦。
 */
export async function runWakeTaskCommand(argv, deps) {
  const {
    platform,
    systemRoot = 'C:\\Windows',
    schtasksExecutor,
    writeXmlFile,
    removeXmlFile,
    fetchJson,
    isElevated,
    now = Date.now,
  } = deps;
  const subcommand = argv[0];

  if (!isWindowsPlatform(platform)) {
    return { ok: false, code: 1, subcommand, reason: 'NON_WINDOWS' };
  }

  if (subcommand === 'enable') {
    const elevation = isElevated();
    if (elevation === ELEVATION_CHECK_FAILED) {
      return { ok: false, code: 1, subcommand, reason: 'ELEVATION_CHECK_FAILED', taskName: WAKE_TASK_NAME };
    }
    if (elevation !== ELEVATION_ELEVATED) {
      return { ok: false, code: 1, subcommand, reason: 'ELEVATION_REQUIRED', taskName: WAKE_TASK_NAME };
    }
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
    const command = resolveTrustedHoldExecutable(systemRoot);
    const argumentsText = TRUSTED_HOLD_ARGUMENTS;
    const workingDirectory = path.join(systemRoot, 'System32');
    const xml = buildWakeTaskXml({
      taskName: WAKE_TASK_NAME,
      description: buildWakeTaskDescription({ dailyAt, timezone, wakeLeadMinutes: WAKE_LEAD_TIME_MINUTES }),
      command,
      arguments: argumentsText,
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
      arguments: argumentsText,
      wakeAt,
      startBoundary,
      dailyAt,
      timezone,
      wakeLeadMinutes: WAKE_LEAD_TIME_MINUTES,
      xml,
      schtasksArgs: createArgs,
    };
  }

  if (subcommand === 'disable') {
    const elevation = isElevated();
    if (elevation === ELEVATION_CHECK_FAILED) {
      return { ok: false, code: 1, subcommand, reason: 'ELEVATION_CHECK_FAILED', taskName: WAKE_TASK_NAME };
    }
    if (elevation !== ELEVATION_ELEVATED) {
      return { ok: false, code: 1, subcommand, reason: 'ELEVATION_REQUIRED', taskName: WAKE_TASK_NAME };
    }
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
      return { ok: true, code: 0, subcommand, taskName: WAKE_TASK_NAME, status: 'absent', staleReasonCodes: [], schtasksArgs: queryArgs };
    }
    const parsed = parseWakeTaskQueryXml(result.stdout);
    if (parsed === null) {
      return { ok: true, code: 0, subcommand, taskName: WAKE_TASK_NAME, status: 'absent', staleReasonCodes: [], schtasksArgs: queryArgs };
    }
    const staleReasonCodes = computeWakeTaskMismatches(parsed, { systemRoot });
    const configured = parseConfiguredScheduleFromDescription(parsed.description);
    const activeSchedule = await resolveWakeScheduleFromBackend(fetchJson);

    let status;
    let scheduleDrift = null;
    if (staleReasonCodes.length > 0) {
      // 静态 contract（command / arguments / settings / principal）不符 → stale，无需再比 schedule。
      status = 'stale';
    } else if (activeSchedule === null) {
      // 后端不可达 → 无法比对 schedule，降级为只读 registered（不臆断 current/stale）。
      status = 'registered';
      scheduleDrift = null;
    } else if (configured === null) {
      // 无配置 marker（旧 task / 非本工具注册）→ 无法证明 current → 需提权 re-bootstrap。
      status = 'stale';
      staleReasonCodes.push('METADATA_MISMATCH');
    } else if (configured.dailyAt !== activeSchedule.dailyAt) {
      status = 'stale';
      staleReasonCodes.push('SCHEDULE_MISMATCH');
      scheduleDrift = true;
    } else {
      status = 'current';
      scheduleDrift = false;
    }

    return {
      ok: true,
      code: 0,
      subcommand,
      taskName: WAKE_TASK_NAME,
      status,
      command: parsed.command,
      arguments: parsed.arguments,
      startBoundary: parsed.startBoundary,
      logonType: parsed.logonType,
      runLevel: parsed.runLevel,
      userId: parsed.userId,
      wakeToRun: parsed.wakeToRun,
      startWhenAvailable: parsed.startWhenAvailable,
      multipleInstancesPolicy: parsed.multipleInstancesPolicy,
      batteryFlags: parsed.disallowStartIfOnBatteries === false && parsed.stopIfGoingOnBatteries === false,
      staleReasonCodes,
      scheduleDrift,
      configuredSchedule: configured,
      activeSchedule,
      requiresElevatedReconciliation: status === 'stale',
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
