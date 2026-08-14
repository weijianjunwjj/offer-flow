/**
 * OfferFlow v0.9 — Windows Autostart 核心逻辑（纯函数，无 side effect）。
 *
 * Task: T031
 * Spec: specs/001-daily-job-hunter/spec.md §假设（用户电脑将 OfferFlow 后端服务作为长期进程运行，Windows 支持操作系统自启动）
 * Plan: specs/001-daily-job-hunter/plan.md §2.7 Autostart
 *
 * 职责边界：
 *  - 本模块只包含「可单测的纯逻辑」：Registry command 构建/解析/ stale 判定、
 *    reg.exe 参数构造、平台门禁、launcher 的 repo root 解析 / flags / spawn 参数 /
 *    runBackend 组合（日志 + 退出码 + 无 restart）。
 *  - 绝不触碰真实 reg.exe、真实 HKCU Run、真实 child_process.spawn、真实文件系统。
 *    这些 side effect 由 windowsAutostart.mjs / offerflowAutostartLauncher.mjs 注入。
 *  - 绝不把 secret 写入任何 command、日志或 env 值。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Registry 常量 ────────────────────────────────────────────────────────────

/** 权威自启动注册表路径（仅用户级，登录后启动，非 boot-before-login）。 */
export const REGISTRY_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** 自启动 value name（权威文档未预定义，此处冻结为稳定名称）。 */
export const VALUE_NAME = 'OfferFlowDailyJobHunter';

// ── Windows command 引用 / 解析 ─────────────────────────────────────────────

/** 用双引号包裹 Windows 路径，兼容空格与中文路径。 */
export function quoteWindowsPath(p) {
  return `"${p}"`;
}

/**
 * 构建 Registry command 字符串：`"<node.exe>" "<launcher.mjs>"`。
 * 只包含 node executable 与 launcher 绝对路径两个 token，绝不包含 secret。
 */
export function buildRegistryCommand({ nodeExecutable, launcherPath }) {
  return `${quoteWindowsPath(nodeExecutable)} ${quoteWindowsPath(launcherPath)}`;
}

/**
 * 解析带引号的 Windows command（由 buildRegistryCommand 生成）为 token 数组。
 * 规则：`"` 进入/退出 quoted 段；quoted 段外的空白分隔 token。
 * 可正确处理空格与中文路径。
 */
export function splitWindowsCommand(command) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (current !== '') {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') tokens.push(current);
  return tokens;
}

/**
 * 反解析 Registry command 为 { nodeExecutable, launcherPath }。
 * 结构不符（token 数不为 2）时返回 null。
 */
export function parseRegistryCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return null;
  const tokens = splitWindowsCommand(command);
  if (tokens.length !== 2) return null;
  const [nodeExecutable, launcherPath] = tokens;
  if (nodeExecutable === '' || launcherPath === '') return null;
  return { nodeExecutable, launcherPath };
}

/**
 * stale 判定：Registry 现存 command 与「当前 repo 的 node executable + launcher path」
 * 不一致（含无法解析）即视为 STALE。repo 移动后 launcher 绝对路径变化 → stale。
 */
export function detectStale({ currentCommand, nodeExecutable, launcherPath }) {
  const parsed = parseRegistryCommand(currentCommand);
  if (parsed === null) return true;
  return parsed.nodeExecutable !== nodeExecutable || parsed.launcherPath !== launcherPath;
}

// ── reg.exe 参数构造 ─────────────────────────────────────────────────────────

/** `reg add ... /v <name> /t REG_SZ /d <command> /f` —— /f 幂等覆盖。 */
export function buildEnableRegArgs({ command }) {
  return ['add', REGISTRY_PATH, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'];
}

/** `reg delete ... /v <name> /f` —— 只删自身 value，绝不删整个 Run key 或其它应用。 */
export function buildDisableRegArgs() {
  return ['delete', REGISTRY_PATH, '/v', VALUE_NAME, '/f'];
}

/** `reg query ... /v <name>` —— 只读探测。 */
export function buildQueryRegArgs() {
  return ['query', REGISTRY_PATH, '/v', VALUE_NAME];
}

/**
 * 从 `reg query` stdout 提取 value data（REG_SZ 之后的内容）。
 * 找不到 value / 无数据时返回 null（表达 disabled）。
 */
export function parseQueryOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const nameIdx = trimmed.indexOf(VALUE_NAME);
    if (nameIdx < 0) continue;
    const rest = trimmed.slice(nameIdx + VALUE_NAME.length).trim();
    const typeIdx = rest.toUpperCase().indexOf('REG_SZ');
    if (typeIdx < 0) continue;
    const data = rest.slice(typeIdx + 'REG_SZ'.length).trim();
    if (data === '') return null;
    return data;
  }
  return null;
}

// ── 平台门禁 ─────────────────────────────────────────────────────────────────

/** 仅 Windows（win32）支持；其它平台明确拒绝，不 fallback 到 PowerShell/CMD。 */
export function isWindowsPlatform(platform) {
  return platform === 'win32';
}

// ── Autostart 命令执行（test seam：regExecutor 可注入 fake） ─────────────────

/**
 * 执行 autostart 子命令（enable / disable / status），返回结构化结果。
 * regExecutor 由调用方注入：真实实现调用 reg.exe（spawnSync），测试注入 fake。
 * 绝不直接操作真实 HKCU Run；真实写入仅在用户显式运行 enable/disable 时发生。
 */
export function runAutostartCommand(argv, deps) {
  const { platform, nodeExecutable, launcherPath, regExecutor } = deps;
  const subcommand = argv[0];

  if (!isWindowsPlatform(platform)) {
    return { ok: false, code: 1, subcommand, reason: 'NON_WINDOWS' };
  }

  if (subcommand === 'enable') {
    const command = buildRegistryCommand({ nodeExecutable, launcherPath });
    const regArgs = buildEnableRegArgs({ command });
    const result = regExecutor(regArgs);
    if (result.status !== 0) {
      return {
        ok: false,
        code: 1,
        subcommand,
        reason: 'REG_ERROR',
        stderr: result.stderr ?? '',
      };
    }
    return { ok: true, code: 0, subcommand, command, regArgs };
  }

  if (subcommand === 'disable') {
    const regArgs = buildDisableRegArgs();
    const result = regExecutor(regArgs);
    // 幂等：value 不存在也算成功，不因「找不到项」报错。
    return {
      ok: true,
      code: 0,
      subcommand,
      regArgs,
      existed: result.status === 0,
    };
  }

  if (subcommand === 'status') {
    const regArgs = buildQueryRegArgs();
    const result = regExecutor(regArgs);
    // reg query 在 value 不存在时返回非零 + 空 stdout → disabled。
    if (result.status !== 0) {
      return { ok: true, code: 0, subcommand, status: 'disabled', regArgs };
    }
    const currentCommand = parseQueryOutput(result.stdout);
    if (currentCommand === null) {
      return { ok: true, code: 0, subcommand, status: 'disabled', regArgs };
    }
    const stale = detectStale({ currentCommand, nodeExecutable, launcherPath });
    return {
      ok: true,
      code: 0,
      subcommand,
      status: 'enabled',
      command: currentCommand,
      stale,
      regArgs,
    };
  }

  return { ok: false, code: 2, subcommand, reason: 'UNKNOWN_COMMAND' };
}

// ── Launcher ─────────────────────────────────────────────────────────────────

/** 从 launcher 自身 import.meta.url 解析 repo root（scripts/autostart/ 上两级），不依赖 cwd。 */
export function resolveRepoRoot(importMetaUrl) {
  const filePath = fileURLToPath(importMetaUrl);
  return path.resolve(path.dirname(filePath), '..', '..');
}

/**
 * 无人值守 backend 的 non-secret runtime flags。
 * 同时开 Scheduler（自动运行）与 DailySearchPlan（暴露 Plan Control / Brief / SourceRun 观测），
 * 后台仍只是同一份 backend process，不额外起 dev server / 浏览器。
 */
export function buildRuntimeFlags() {
  return {
    OFFERFLOW_DAILY_JOB_SCHEDULER: 'true',
    OFFERFLOW_DAILY_SEARCH_PLAN: 'true',
  };
}

/** tsx 真实 ESM CLI entry 绝对路径（不依赖 shell / npm / .cmd shim）。 */
export function resolveTsxCli(repoRoot) {
  return path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

/** 后端启动入口（tsx 目标）。 */
export function resolveBackendEntry(repoRoot) {
  return path.join(repoRoot, 'server', 'index.ts');
}

/** 每日日志文件名：offerflow-autostart-YYYY-MM-DD.log（本地时区自然日）。 */
export function composeLogFileName(now = Date.now()) {
  const d = new Date(now);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `offerflow-autostart-${yyyy}-${mm}-${dd}.log`;
}

/**
 * 构建 backend 启动参数（纯数据，不真正 spawn）。
 * env 继承父进程（含可能的用户级 credential env），再叠加 non-secret flags；
 * 绝不注入、绝不打印 secret 值。
 */
export function buildBackendSpawn({
  nodeExecutable,
  tsxCli,
  backendEntry,
  flags,
  parentEnv,
}) {
  return {
    command: nodeExecutable,
    args: [tsxCli, backendEntry],
    env: { ...parentEnv, ...flags },
  };
}

/**
 * launcher 核心组合：chdir → 校验入口存在 → 写 header 日志 → spawn backend →
 * stdout/stderr 落日志 → 记录退出码/信号后返回（无 restart loop、无 crash supervisor）。
 *
 * 所有 side effect（chdir / 文件存在性 / mkdir / 日志写入 / spawn）都通过 deps 注入，
 * 以便测试用 fake 替代真实进程与文件系统。
 */
export async function runBackend(deps) {
  const {
    repoRoot,
    nodeExecutable,
    tsxCli,
    backendEntry,
    flags,
    parentEnv,
    logDir,
    logFileName,
    chdirFn,
    existsSyncFn,
    mkdirSyncFn,
    writeLog,
    spawnFn,
  } = deps;

  chdirFn(repoRoot);

  if (!existsSyncFn(backendEntry)) {
    return { exitCode: 1, missingEntry: backendEntry };
  }

  mkdirSyncFn(logDir, { recursive: true });
  const logPath = path.join(logDir, logFileName);

  const header = [
    '[autostart] launcher start',
    `  repoRoot=${repoRoot}`,
    `  node=${nodeExecutable}`,
    `  backendEntry=${backendEntry}`,
    `  scheduler=${flags.OFFERFLOW_DAILY_JOB_SCHEDULER}`,
    `  dailySearchPlan=${flags.OFFERFLOW_DAILY_SEARCH_PLAN}`,
  ].join('\n');
  writeLog(logPath, `${header}\n`);

  const child = spawnFn(nodeExecutable, [tsxCli, backendEntry], {
    cwd: repoRoot,
    env: { ...parentEnv, ...flags },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  writeLog(logPath, `[autostart] backend PID ${child.pid}\n`);

  child.stdout?.on('data', (chunk) => writeLog(logPath, String(chunk)));
  child.stderr?.on('data', (chunk) => writeLog(logPath, String(chunk)));

  return await new Promise((resolve) => {
    child.once('error', (err) => {
      const message = err && err.message ? err.message : String(err);
      writeLog(logPath, `[autostart] backend spawn error: ${message}\n`);
      resolve({ exitCode: 1, spawnError: message });
    });
    child.once('exit', (code, signal) => {
      writeLog(logPath, `[autostart] backend exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
      resolve({ exitCode: code ?? (signal ? 1 : 0), code, signal });
    });
  });
}
