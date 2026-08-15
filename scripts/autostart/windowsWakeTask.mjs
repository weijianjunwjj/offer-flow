/**
 * OfferFlow v0.9 — Windows Wake Task 管理 CLI。
 *
 * 子命令（v0.9 Wake Admin-Bootstrap 语义）：
 *   enable   提权安装/覆盖（从后端 active PlanVersion.schedule 读 dailyAt，注册 WakeToRun wake task）
 *   disable  提权卸载（删除 OfferFlow 自己的 wake task，幂等，绝不删其它任务）
 *   status   只读探测：absent / registered / current / stale；stale 时提示需提权 reconcile
 *
 * 安全边界：
 *  - 通过 spawnSync 直接调用 schtasks.exe，绝不经过 CMD / PowerShell / shell。
 *  - enable / disable 是 PRIVILEGED INSTALL / UNINSTALL：非提权上下文直接 ELEVATION_REQUIRED，
 *    绝不调用 schtasks /Create /Delete，也不给用户模糊的 Access Denied。
 *  - status 是 READ ONLY，普通用户可运行；若 Windows 限制导致不可读，降级为 registered（不臆断）。
 *  - task command 只含 node executable + wake bridge 路径，绝不含 cmd.exe / powershell.exe / secret。
 *  - 非 Windows 平台明确拒绝。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveRepoRoot } from './autostartCore.mjs';
import { runWakeTaskCommand } from './wakeCore.mjs';

/** 真实 schtasks.exe executor（spawnSync，不经过 shell）。 */
function createSchtasksExecutor() {
  return (args) => {
    const result = spawnSync('schtasks.exe', args, { encoding: 'utf-8' });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

/**
 * 提权上下文检测：`whoami /groups` 输出含高完整性 SID（S-1-16-12288）即 elevated。
 * 只读、不 mutation；不经过 shell / CMD / PowerShell。
 */
function createIsElevated() {
  return () => {
    const result = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf-8' });
    if (result.status !== 0) return false;
    return /S-1-16-12288/i.test(result.stdout ?? '');
  };
}

/** 把 XML 写入系统临时目录，返回临时文件绝对路径。 */
function createWriteXmlFile() {
  return (xml) => {
    const filePath = path.join(os.tmpdir(), `offerflow-wake-task-${process.pid}.xml`);
    fs.writeFileSync(filePath, xml, 'utf-8');
    return filePath;
  };
}

/** 删除临时 XML（best-effort）。 */
function createRemoveXmlFile() {
  return (filePath) => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // 忽略：临时文件清理失败不影响任务注册结果。
    }
  };
}

/** 真实后端 HTTP fetch（global fetch，Node 18+）。后端不可用 → 抛错。 */
function createFetchJson() {
  const base = 'http://127.0.0.1:17365';
  return async (pathname) => {
    const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`backend responded ${response.status}`);
    return response.json();
  };
}

/** 当前 repo 的 wake bridge 绝对路径（manager 与 bridge 同目录）。 */
function resolveWakeBridgePath(repoRoot) {
  return path.join(repoRoot, 'scripts', 'autostart', 'offerflowWakeBridge.mjs');
}

function printResult(result) {
  if (result.subcommand === 'status') {
    if (result.status === 'absent') {
      console.log('status: absent');
    } else if (result.status === 'registered') {
      console.log('status: registered');
      console.log('  （后端不可达，无法比对当前 active plan schedule；仅确认 task 已注册且命令/设置当前）');
      console.log(`command: ${result.command}`);
      console.log(`startBoundary: ${result.startBoundary ?? ''}`);
    } else {
      console.log(`status: ${result.status}`);
      console.log(`command: ${result.command}`);
      console.log(`arguments: ${result.arguments}`);
      console.log(`startBoundary: ${result.startBoundary ?? ''}`);
      const s = result.settings;
      if (s) {
        console.log(`wakeToRun: ${s.wakeToRun}`);
        console.log(`startWhenAvailable: ${s.startWhenAvailable ?? 'unknown'}`);
        console.log(`multipleInstancesPolicy: ${s.multipleInstancesPolicy ?? 'unknown'}`);
        console.log(`batteryFlags: ${s.batteryFlags ?? 'unknown'}`);
        console.log(`commandSafe: ${s.commandSafe}`);
      }
      if (result.configuredSchedule) {
        console.log(`configuredDailyAt: ${result.configuredSchedule.dailyAt} (${result.configuredSchedule.timezone})`);
      } else {
        console.log('configuredDailyAt: unknown');
      }
      if (result.activeSchedule) {
        console.log(`activePlanDailyAt: ${result.activeSchedule.dailyAt} (${result.activeSchedule.timezone})`);
      } else {
        console.log('activePlanDailyAt: unknown');
      }
      if (result.commandDrift) {
        console.log('commandDrift: YES（node.exe / wake bridge 路径变化，需提权 re-bootstrap）');
      }
      if (result.status === 'stale') {
        console.log('REQUIRES_ELEVATED_RECONCILIATION: YES');
      } else {
        console.log('REQUIRES_ELEVATED_RECONCILIATION: NO');
      }
    }
    return;
  }
  if (result.ok) {
    if (result.subcommand === 'enable') {
      console.log('enabled');
      console.log(`task: ${result.taskName}`);
      console.log(`dailyAt: ${result.dailyAt} (${result.timezone})`);
      console.log(`wakeAt: ${result.wakeAt}`);
      console.log(`command: ${result.command}`);
    } else if (result.subcommand === 'disable') {
      console.log(result.existed ? 'disabled' : 'disabled (no existing task)');
    }
    return;
  }
  if (result.reason === 'NON_WINDOWS') {
    console.error('拒绝：Windows Wake Task 仅支持 win32 平台。');
  } else if (result.reason === 'ELEVATION_REQUIRED') {
    console.error('拒绝：enable / disable 需要管理员权限（提权上下文）。');
    console.error('请先关闭当前窗口，从 Windows 开始菜单右键「Git Bash」→「以管理员身份运行」，然后重新执行：');
    console.error('  npm run wake-task:enable');
    console.error('（或 npm run wake-task:disable）');
  } else if (result.reason === 'NO_ACTIVE_PLAN') {
    console.error('拒绝：未找到 active plan 的 schedule。请先在后端配置并激活一个 DailySearchPlan。');
  } else if (result.reason === 'UNKNOWN_COMMAND') {
    console.error('用法：node scripts/autostart/windowsWakeTask.mjs <enable|disable|status>');
  } else if (result.reason === 'SCHTASKS_ERROR') {
    console.error('schtasks.exe 执行失败：');
    console.error(result.stderr ?? '');
  } else {
    console.error('未知错误。');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const repoRoot = resolveRepoRoot(import.meta.url);
  const result = await runWakeTaskCommand(argv, {
    platform: process.platform,
    nodeExecutable: process.execPath,
    wakeBridgePath: resolveWakeBridgePath(repoRoot),
    workingDirectory: repoRoot,
    schtasksExecutor: createSchtasksExecutor(),
    writeXmlFile: createWriteXmlFile(),
    removeXmlFile: createRemoveXmlFile(),
    fetchJson: createFetchJson(),
    isElevated: createIsElevated(),
  });
  printResult(result);
  process.exitCode = result.code;
}

await main();
