/**
 * OfferFlow v0.9 — Windows Autostart 管理 CLI（T031）。
 *
 * 子命令：
 *   enable   将 `"<node.exe>" "<launcher.mjs>"` 写入 HKCU\...\Run（幂等 /f）
 *   disable  只删除 OfferFlow 自己的 value（幂等，绝不删整个 Run key）
 *   status   只读探测：enabled / disabled，enabled 时附带 current command 与 stale 判定
 *
 * 安全边界：
 *  - 通过 spawnSync 直接调用 reg.exe，绝不经过 CMD / PowerShell / shell。
 *  - 真实 HKCU Run 的写入只在用户显式运行 enable / disable 时发生。
 *  - Registry command 只含 node executable + launcher 绝对路径，绝不包含 secret。
 *  - 非 Windows 平台明确拒绝。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  resolveRepoRoot,
  runAutostartCommand,
} from './autostartCore.mjs';

/** 真实 reg.exe executor（spawnSync，不经过 shell）。 */
function createRegExecutor() {
  return (args) => {
    const result = spawnSync('reg.exe', args, { encoding: 'utf-8' });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
}

/** 当前 repo 的 launcher 绝对路径（manager 与 launcher 同目录）。 */
function resolveLauncherPath(repoRoot) {
  return path.join(repoRoot, 'scripts', 'autostart', 'offerflowAutostartLauncher.mjs');
}

function printResult(result) {
  if (result.subcommand === 'status' && result.status) {
    if (result.status === 'disabled') {
      console.log('status: disabled');
    } else {
      console.log('status: enabled');
      console.log(`command: ${result.command}`);
      console.log(`stale: ${result.stale ? 'STALE' : 'OK'}`);
    }
    return;
  }
  if (result.ok) {
    if (result.subcommand === 'enable') {
      console.log('enabled');
      console.log(`command: ${result.command}`);
    } else if (result.subcommand === 'disable') {
      console.log(result.existed ? 'disabled' : 'disabled (no existing value)');
    }
    return;
  }
  // 失败分支
  if (result.reason === 'NON_WINDOWS') {
    console.error('拒绝：Windows Autostart 仅支持 win32 平台。');
  } else if (result.reason === 'UNKNOWN_COMMAND') {
    console.error('用法：node scripts/autostart/windowsAutostart.mjs <enable|disable|status>');
  } else if (result.reason === 'REG_ERROR') {
    console.error('reg.exe 执行失败：');
    console.error(result.stderr ?? '');
  } else {
    console.error('未知错误。');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const repoRoot = resolveRepoRoot(import.meta.url);
  const result = runAutostartCommand(argv, {
    platform: process.platform,
    nodeExecutable: process.execPath,
    launcherPath: resolveLauncherPath(repoRoot),
    regExecutor: createRegExecutor(),
  });
  printResult(result);
  process.exitCode = result.code;
}

main();
