/**
 * OfferFlow v0.9 — Windows Autostart Launcher 测试（T031 / PART 14）。
 *
 * 覆盖：repo root 解析（任意 cwd）/ 只启动 backend 不启动 Vite / scheduler flag /
 * dailySearchPlan flag / 父级 credential env 继承 / 不打印 credential / stdout 落日志 /
 * stderr 落日志 / exit code 记录 / 无 restart loop / schema refusal stderr 落日志 /
 * 路径含空格可运行。
 *
 * 全部通过 fake spawn + fake 文件系统测 runBackend / buildBackendSpawn 等纯逻辑，
 * 不真实 spawn 后端、不真实调用外部 provider、不写真实文件。
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildBackendSpawn,
  buildRuntimeFlags,
  composeLogFileName,
  resolveBackendEntry,
  resolveRepoRoot,
  resolveTsxCli,
  runBackend,
} from './autostartCore.mjs';
import type { RunBackendDeps, RunBackendResult } from './autostartCore.mjs';

const LAUNCHER_URL = 'file:///D:/VSCode/offer-flow/scripts/autostart/offerflowAutostartLauncher.mjs';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('resolveRepoRoot — 不依赖 cwd', () => {
  it('从 launcher 自身 import.meta.url 解析 repo root', () => {
    // 无论 cwd 在哪，结果只由 import.meta.url 决定。
    const spy = vi.spyOn(process, 'cwd').mockReturnValue('C:\\somewhere\\else');
    try {
      expect(resolveRepoRoot(LAUNCHER_URL)).toBe('D:\\VSCode\\offer-flow');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('buildRuntimeFlags — 双开关', () => {
  it('OFFERFLOW_DAILY_JOB_SCHEDULER=true', () => {
    expect(buildRuntimeFlags().OFFERFLOW_DAILY_JOB_SCHEDULER).toBe('true');
  });

  it('OFFERFLOW_DAILY_SEARCH_PLAN=true', () => {
    expect(buildRuntimeFlags().OFFERFLOW_DAILY_SEARCH_PLAN).toBe('true');
  });
});

describe('buildBackendSpawn — 只启动 backend，不启动 Vite', () => {
  const repoRoot = 'D:\\VSCode\\offer-flow';

  it('args = tsx cli + server/index.ts，不含 vite/dev server', () => {
    const spawn = buildBackendSpawn({
      nodeExecutable: 'D:\\nodejs\\node.exe',
      tsxCli: resolveTsxCli(repoRoot),
      backendEntry: resolveBackendEntry(repoRoot),
      flags: buildRuntimeFlags(),
      parentEnv: {},
    });
    expect(spawn.command).toBe('D:\\nodejs\\node.exe');
    expect(spawn.args).toHaveLength(2);
    expect(spawn.args[0]).toBe(resolveTsxCli(repoRoot));
    expect(spawn.args[1]).toBe(resolveBackendEntry(repoRoot));
    expect(spawn.args.join(' ')).not.toMatch(/vite|dev|browser/i);
  });

  it('backendEntry 指向 server/index.ts', () => {
    expect(resolveBackendEntry(repoRoot).replace(/\\/g, '/')).toBe('D:/VSCode/offer-flow/server/index.ts');
  });

  it('父级 credential env 被继承且 non-secret flags 叠加', () => {
    const parentEnv = { DEEPSEEK_API_KEY: 'super-secret', TAVILY_API_KEY: 'tvly-x', OTHER: 'keep' };
    const spawn = buildBackendSpawn({
      nodeExecutable: 'D:\\nodejs\\node.exe',
      tsxCli: resolveTsxCli(repoRoot),
      backendEntry: resolveBackendEntry(repoRoot),
      flags: buildRuntimeFlags(),
      parentEnv,
    });
    expect(spawn.env.DEEPSEEK_API_KEY).toBe('super-secret');
    expect(spawn.env.TAVILY_API_KEY).toBe('tvly-x');
    expect(spawn.env.OTHER).toBe('keep');
    expect(spawn.env.OFFERFLOW_DAILY_JOB_SCHEDULER).toBe('true');
    expect(spawn.env.OFFERFLOW_DAILY_SEARCH_PLAN).toBe('true');
  });

  it('路径含空格时 args 仍是完整路径字符串（不拆散）', () => {
    const spacedRoot = 'D:\\My Projects\\offer flow';
    const spawn = buildBackendSpawn({
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      tsxCli: resolveTsxCli(spacedRoot),
      backendEntry: resolveBackendEntry(spacedRoot),
      flags: buildRuntimeFlags(),
      parentEnv: {},
    });
    expect(spawn.args[0]).toContain(' ');
    expect(spawn.args[1]).toContain(' ');
    expect(spawn.args[0]).toBe('D:\\My Projects\\offer flow\\node_modules\\tsx\\dist\\cli.mjs');
  });
});

describe('composeLogFileName', () => {
  it('生成 YYYY-MM-DD 文件名', () => {
    // 2026-08-14 本地零点
    const now = new Date(2026, 7, 14, 0, 0, 0).getTime();
    expect(composeLogFileName(now)).toBe('offerflow-autostart-2026-08-14.log');
  });
});

describe('runBackend — 组合行为（fake spawn + fake 文件系统）', () => {
  function makeDeps(overrides: Record<string, unknown> = {}) {
    const repoRoot = 'D:\\VSCode\\offer-flow';
    const written: string[] = [];
    const child = fakeChild();
    const spawnFn = vi.fn((_cmd: string, _args: string[], _opts: Record<string, unknown>) => child);
    const deps = {
      repoRoot,
      nodeExecutable: 'D:\\nodejs\\node.exe',
      tsxCli: resolveTsxCli(repoRoot),
      backendEntry: resolveBackendEntry(repoRoot),
      flags: buildRuntimeFlags(),
      parentEnv: { DEEPSEEK_API_KEY: 'super-secret' },
      logDir: 'D:\\VSCode\\offer-flow\\logs\\autostart',
      logFileName: 'offerflow-autostart-2026-08-14.log',
      chdirFn: vi.fn(),
      existsSyncFn: vi.fn(() => true),
      mkdirSyncFn: vi.fn(),
      writeLog: vi.fn((_p: string, content: string) => { written.push(content); }),
      spawnFn,
      ...overrides,
    };
    return { deps, written, spawnFn, child };
  }

  it('chdir 到 repoRoot 且确认后端入口存在', async () => {
    const { deps, child } = makeDeps();
    const promise = runBackend(deps);
    child.emit('exit', 0, null);
    await promise;
    expect(deps.chdirFn).toHaveBeenCalledWith('D:\\VSCode\\offer-flow');
    expect(deps.existsSyncFn).toHaveBeenCalledWith(resolveBackendEntry('D:\\VSCode\\offer-flow'));
    expect(deps.mkdirSyncFn).toHaveBeenCalled();
  });

  it('后端入口缺失时不 spawn、返回 exitCode 1', async () => {
    const { deps, spawnFn } = makeDeps({ existsSyncFn: vi.fn(() => false) });
    const result = await runBackend(deps);
    expect(result.exitCode).toBe(1);
    expect(result.missingEntry).toBe(resolveBackendEntry('D:\\VSCode\\offer-flow'));
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawn 参数：cwd=repoRoot、env 继承+flags、stdio pipe、windowsHide', async () => {
    const { deps, child } = makeDeps();
    const promise = runBackend(deps);
    child.emit('exit', 0, null);
    await promise;
    expect(deps.spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = deps.spawnFn.mock.calls[0];
    expect(cmd).toBe('D:\\nodejs\\node.exe');
    expect(args).toEqual([resolveTsxCli('D:\\VSCode\\offer-flow'), resolveBackendEntry('D:\\VSCode\\offer-flow')]);
    expect(opts.cwd).toBe('D:\\VSCode\\offer-flow');
    expect(opts.windowsHide).toBe(true);
    expect((opts.env as Record<string, string>).OFFERFLOW_DAILY_JOB_SCHEDULER).toBe('true');
    expect((opts.env as Record<string, string>).DEEPSEEK_API_KEY).toBe('super-secret');
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('stdout 内容写入日志', async () => {
    const { deps, written, child } = makeDeps();
    const promise = runBackend(deps);
    child.stdout.emit('data', 'backend stdout line\n');
    child.emit('exit', 0, null);
    await promise;
    expect(written.join('')).toContain('backend stdout line');
  });

  it('stderr 内容写入日志（含 schema refusal 文案）', async () => {
    const { deps, written, child } = makeDeps();
    const promise = runBackend(deps);
    child.stderr.emit('data', '拒绝启动：schema 版本过低，请先执行迁移\n');
    child.emit('exit', 1, null);
    await promise;
    expect(written.join('')).toContain('拒绝启动：schema 版本过低');
  });

  it('backend exit code 被记录', async () => {
    const { deps, written, child } = makeDeps();
    const promise = runBackend(deps);
    child.emit('exit', 5, null);
    const result = await promise;
    expect(result.exitCode).toBe(5);
    expect(written.join('')).toContain('code=5');
  });

  it('signal 退出时返回非零退出码并记录 signal', async () => {
    const { deps, written, child } = makeDeps();
    const promise = runBackend(deps);
    child.emit('exit', null, 'SIGTERM');
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(written.join('')).toContain('signal=SIGTERM');
  });

  it('无 restart loop：backend 退出后只 spawn 一次', async () => {
    const { deps, spawnFn, child } = makeDeps();
    const promise = runBackend(deps);
    child.emit('exit', 0, null);
    await promise;
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('launcher 不打印 credential（日志内容不含 secret）', async () => {
    const { deps, written, child } = makeDeps();
    const promise = runBackend(deps);
    child.stdout.emit('data', 'normal log\n');
    child.emit('exit', 0, null);
    await promise;
    const all = written.join('');
    expect(all).not.toContain('super-secret');
    expect(all).not.toMatch(/TAVILY_API_KEY|DEEPSEEK_API_KEY|Authorization/i);
  });

  it('spawn error 被记录并返回 exitCode 1', async () => {
    const { deps, written, spawnFn } = makeDeps();
    const child = fakeChild();
    spawnFn.mockReturnValue(child);
    const promise = runBackend(deps);
    child.emit('error', new Error('spawn failed'));
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.spawnError).toBe('spawn failed');
    expect(written.join('')).toContain('spawn failed');
  });
});

describe('offerflowAutostartLauncher — 模块导入与 main 执行（launcher-level）', () => {
  // launcher 的 main 会写 process.exitCode；测试后恢复，避免污染其它用例。
  async function withExitCodeRestored<T>(fn: () => T | Promise<T>): Promise<T> {
    const saved = process.exitCode;
    try {
      return await fn();
    } finally {
      process.exitCode = saved;
    }
  }

  it('launcher 文件可被 import（无 SyntaxError），导入时不自动 spawn backend', async () => {
    // 关键回归：此前 function main() 内 await 导致 SyntaxError，import 直接抛错。
    const mod = await import('./offerflowAutostartLauncher.mjs');
    expect(typeof mod.main).toBe('function');
  });

  it('main 是 async execution path，正确 await runBackendImpl 的 Promise', async () => {
    const { main } = await import('./offerflowAutostartLauncher.mjs');
    let resolveBackend!: (r: RunBackendResult) => void;
    const runBackendImpl = vi.fn(
      (_deps: RunBackendDeps) => new Promise<RunBackendResult>((resolve) => { resolveBackend = resolve; }),
    );
    await withExitCodeRestored(async () => {
      const promise = main({ runBackendImpl });
      // runBackendImpl 已被调用，但其 Promise 尚未 resolve —— main 必须等待，不能提前返回。
      expect(runBackendImpl).toHaveBeenCalledTimes(1);
      resolveBackend({ exitCode: 7 });
      const result = await promise;
      expect(result.exitCode).toBe(7);
    });
  });

  it('main 向 runBackendImpl 传入正式 backend contract（不含 secret）', async () => {
    const { main } = await import('./offerflowAutostartLauncher.mjs');
    const runBackendImpl = vi.fn(async (_deps: RunBackendDeps): Promise<RunBackendResult> => ({ exitCode: 0 }));
    await withExitCodeRestored(() => main({ runBackendImpl }));
    expect(runBackendImpl).toHaveBeenCalledTimes(1);
    const deps = runBackendImpl.mock.calls[0][0];
    expect(deps.repoRoot).toBe(resolveRepoRoot(LAUNCHER_URL));
    expect(deps.nodeExecutable).toBe(process.execPath);
    expect(deps.tsxCli).toBe(resolveTsxCli('D:\\VSCode\\offer-flow'));
    expect(deps.backendEntry).toBe(resolveBackendEntry('D:\\VSCode\\offer-flow'));
    expect(deps.flags).toEqual({
      OFFERFLOW_DAILY_JOB_SCHEDULER: 'true',
      OFFERFLOW_DAILY_SEARCH_PLAN: 'true',
    });
    expect(deps.logDir).toBe('D:\\VSCode\\offer-flow\\logs\\autostart');
    // 按当前真实实现验证 contract 字段：不发明字段、不额外注入 secret 到 flags。
    expect(Object.keys(deps).sort()).toEqual([
      'backendEntry', 'chdirFn', 'existsSyncFn', 'flags', 'logDir', 'logFileName',
      'mkdirSyncFn', 'nodeExecutable', 'parentEnv', 'repoRoot', 'spawnFn', 'tsxCli', 'writeLog',
    ].sort());
  });

  it('runBackend failure（exitCode 1）→ launcher process.exitCode 非 0', async () => {
    const { main } = await import('./offerflowAutostartLauncher.mjs');
    const runBackendImpl = vi.fn(async (_deps: RunBackendDeps): Promise<RunBackendResult> => ({ exitCode: 1, spawnError: 'spawn failed' }));
    await withExitCodeRestored(async () => {
      await main({ runBackendImpl });
      expect(process.exitCode).toBe(1);
    });
  });

  it('main 通过 seam 注入 fake runBackendImpl，不触碰真实 spawn / backend', async () => {
    // 所有 launcher-level 用例都注入 fake；这里明确确认默认实现可被替换，测试绝不真实 spawn。
    const { main } = await import('./offerflowAutostartLauncher.mjs');
    const runBackendImpl = vi.fn(async (_deps: RunBackendDeps): Promise<RunBackendResult> => ({ exitCode: 0 }));
    await withExitCodeRestored(() => main({ runBackendImpl }));
    expect(runBackendImpl).toHaveBeenCalledTimes(1);
  });
});
