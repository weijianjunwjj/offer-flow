/**
 * OfferFlow v0.9 — Windows Autostart Launcher（T031）。
 *
 * 由 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 登录后启动：
 *
 *   node.exe  →  offerflowAutostartLauncher.mjs
 *
 * 职责（架构冻结，单一 backend 长期进程）：
 *   1. 不依赖调用时 cwd —— 从自身 import.meta.url 解析 repo root。
 *   2. process.chdir(repoRoot)。
 *   3. 确认后端启动入口（server/index.ts）存在。
 *   4. 设置 non-secret flags：OFFERFLOW_DAILY_JOB_SCHEDULER / OFFERFLOW_DAILY_SEARCH_PLAN = true。
 *   5. 保留父进程已有 credential env（叠加 flags，绝不覆盖、绝不打印）。
 *   6. 用 process.execPath + tsx CLI entry 启动 backend（不依赖 shell / npm / .cmd shim）。
 *   7. stdout/stderr 写入 logs/autostart/ 日志。
 *   8. backend 退出后 launcher 也退出（记录退出码/信号）。
 *
 * 明确不做：crash supervisor、无限 restart loop、Vite dev server、HMR、浏览器、第二个 daemon。
 * 真实生产库 schema 低于所需版本时，server/index.ts 自身会拒绝启动（allowAutoMigrate=false），
 * 该 stderr 会落到日志，供排障。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRuntimeFlags,
  composeLogFileName,
  resolveBackendEntry,
  resolveRepoRoot,
  resolveTsxCli,
  runBackend,
} from './autostartCore.mjs';

/**
 * launcher 主执行路径（async）。runBackendImpl 是测试 seam：
 * 生产环境默认注入真实 runBackend，测试注入 fake 以避免真实 spawn backend。
 */
export async function main({ runBackendImpl = runBackend } = {}) {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const flags = buildRuntimeFlags();
  const tsxCli = resolveTsxCli(repoRoot);
  const backendEntry = resolveBackendEntry(repoRoot);

  const result = await runBackendImpl({
    repoRoot,
    nodeExecutable: process.execPath,
    tsxCli,
    backendEntry,
    flags,
    parentEnv: process.env,
    logDir: path.join(repoRoot, 'logs', 'autostart'),
    logFileName: composeLogFileName(),
    chdirFn: (dir) => process.chdir(dir),
    existsSyncFn: (p) => fs.existsSync(p),
    mkdirSyncFn: (dir, opts) => fs.mkdirSync(dir, opts),
    writeLog: (logPath, content) => {
      try {
        fs.appendFileSync(logPath, content, 'utf-8');
      } catch {
        // 日志写入失败不影响 backend 启动；吞掉避免二次崩溃掩盖真实退出原因。
      }
    },
    spawnFn: spawn,
  });

  process.exitCode = result.exitCode;
  return result;
}

// 仅作为直接入口执行时运行；被测试 import 时不自动 spawn backend。
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  await main();
}
