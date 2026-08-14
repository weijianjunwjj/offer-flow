/**
 * 声明文件：offerflowAutostartLauncher.mjs 的 TypeScript 类型。
 * 仅用于 vue-tsc 类型检查与 .spec.ts 导入，运行时由 offerflowAutostartLauncher.mjs 提供实现。
 */

import type { RunBackendDeps, RunBackendResult } from './autostartCore.mjs';

export interface LauncherMainDeps {
  /** 测试 seam：生产默认注入真实 runBackend，测试注入 fake 以避免真实 spawn backend。 */
  runBackendImpl?: (deps: RunBackendDeps) => Promise<RunBackendResult>;
}

export function main(deps?: LauncherMainDeps): Promise<RunBackendResult>;
