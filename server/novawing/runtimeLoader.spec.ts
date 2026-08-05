import { describe, expect, it } from 'vitest';
import type { NovaWingHostAdapter } from '../radar/analysis/novaWingHostAdapter';
import { loadNovaWingRuntime, type NovaWingRuntimeHandle } from './runtimeLoader';

const fakeAdapter: NovaWingHostAdapter = {
  readLatestMainline: () => ({ coreRevision: 0, entries: [] }),
};

describe('loadNovaWingRuntime', () => {
  it('does not load infrastructure while the feature is disabled', async () => {
    let loads = 0;
    const loaded = await loadNovaWingRuntime(
      { enabled: false, databasePath: 'unused' },
      async () => {
        loads += 1;
        throw new Error('must not load');
      },
    );
    expect(loaded).toEqual({ adapter: undefined, ownedRuntime: undefined });
    expect(loads).toBe(0);
  });

  it('gives an explicitly injected fake priority without loading or owning it', async () => {
    let loads = 0;
    const loaded = await loadNovaWingRuntime(
      { enabled: true, databasePath: 'unused', injectedAdapter: fakeAdapter },
      async () => {
        loads += 1;
        throw new Error('must not load');
      },
    );
    expect(loaded).toEqual({ adapter: fakeAdapter, ownedRuntime: undefined });
    expect(loads).toBe(0);
  });

  it('loads and owns the real runtime only when enabled without an injection', async () => {
    const runtime: NovaWingRuntimeHandle = { adapter: fakeAdapter, close: () => undefined };
    let databasePath = '';
    const loaded = await loadNovaWingRuntime(
      { enabled: true, databasePath: 'runtime.sqlite3' },
      async () => ({
        createNovaWingRuntime: (options) => {
          databasePath = options.databasePath;
          return runtime;
        },
      }),
    );
    expect(databasePath).toBe('runtime.sqlite3');
    expect(loaded).toEqual({ adapter: fakeAdapter, ownedRuntime: runtime });
  });

  it('redacts infrastructure load failures behind a stable initialization error', async () => {
    await expect(loadNovaWingRuntime(
      { enabled: true, databasePath: 'C:\\private\\business.sqlite3' },
      async () => { throw new Error('module failed at C:\\private\\source.ts'); },
    )).rejects.toMatchObject({
      code: 'NOVA_WING_RUNTIME_INITIALIZATION_FAILED',
      message: 'NovaWing runtime 初始化失败',
    });
  });
});
