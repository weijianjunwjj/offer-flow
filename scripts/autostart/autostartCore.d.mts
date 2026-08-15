/**
 * 声明文件：autostartCore.mjs 的 TypeScript 类型。
 * 仅用于 vue-tsc 类型检查与 .spec.ts 导入，运行时由 autostartCore.mjs 提供实现。
 */

export const REGISTRY_PATH: string;
export const VALUE_NAME: string;

export function quoteWindowsPath(p: string): string;

export interface RegistryCommandParts {
  nodeExecutable: string;
  launcherPath: string;
}

export function buildRegistryCommand(parts: RegistryCommandParts): string;
export function splitWindowsCommand(command: string): string[];
export function parseRegistryCommand(command: string): RegistryCommandParts | null;

export interface StaleInput {
  currentCommand: string;
  nodeExecutable: string;
  launcherPath: string;
}
export function detectStale(input: StaleInput): boolean;

export function buildEnableRegArgs(input: { command: string }): string[];
export function buildDisableRegArgs(): string[];
export function buildQueryRegArgs(): string[];
export function parseQueryOutput(stdout: string | null | undefined): string | null;

export function isWindowsPlatform(platform: string): boolean;

export interface RegExecutorResult {
  status: number;
  stdout?: string | null;
  stderr?: string | null;
}
export type RegExecutor = (args: string[]) => RegExecutorResult;

export interface AutostartRunDeps {
  platform: string;
  nodeExecutable: string;
  launcherPath: string;
  regExecutor: RegExecutor;
}

export interface AutostartRunResult {
  ok: boolean;
  code: number;
  subcommand?: string;
  reason?: string;
  stderr?: string;
  command?: string;
  regArgs?: string[];
  status?: 'enabled' | 'disabled';
  stale?: boolean;
  existed?: boolean;
}

export function runAutostartCommand(
  argv: string[],
  deps: AutostartRunDeps,
): AutostartRunResult;

export function resolveRepoRoot(importMetaUrl: string): string;

export interface RuntimeFlags {
  OFFERFLOW_DAILY_JOB_SCHEDULER: string;
  OFFERFLOW_DAILY_SEARCH_PLAN: string;
  OFFERFLOW_WAKE_SCHEDULER: string;
}
export function buildRuntimeFlags(): RuntimeFlags;

export function resolveTsxCli(repoRoot: string): string;
export function resolveBackendEntry(repoRoot: string): string;
export function composeLogFileName(now?: number): string;

export interface BackendSpawnInput {
  nodeExecutable: string;
  tsxCli: string;
  backendEntry: string;
  flags: RuntimeFlags;
  parentEnv: Record<string, string | undefined>;
}
export interface BackendSpawn {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}
export function buildBackendSpawn(input: BackendSpawnInput): BackendSpawn;

export interface RunBackendResult {
  exitCode: number;
  missingEntry?: string;
  spawnError?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface RunBackendDeps {
  repoRoot: string;
  nodeExecutable: string;
  tsxCli: string;
  backendEntry: string;
  flags: RuntimeFlags;
  parentEnv: Record<string, string | undefined>;
  logDir: string;
  logFileName: string;
  chdirFn: (dir: string) => void;
  existsSyncFn: (p: string) => boolean;
  mkdirSyncFn: (dir: string, opts?: { recursive?: boolean }) => unknown;
  writeLog: (logPath: string, content: string) => void;
  spawnFn: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    pid: number;
    stdout?: { on: (event: 'data', cb: (chunk: unknown) => void) => void } | null;
    stderr?: { on: (event: 'data', cb: (chunk: unknown) => void) => void } | null;
    once: (event: 'error' | 'exit', cb: (...args: unknown[]) => void) => void;
  };
}

export function runBackend(deps: RunBackendDeps): Promise<RunBackendResult>;
