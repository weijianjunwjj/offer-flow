import { describe, expect, it } from 'vitest';
import { FakeNovaWingHostAdapter } from './fakeNovaWingHostAdapter.specHelper';
import {
  NovaWingContextError,
  normalizeNovaWingContext,
  readFrozenNovaWingContext,
} from './novaWingContext';

const context = () => ({
  coreRevision: 7,
  entries: [
    { scope: 'career' as const, key: 'target.role', value: { z: 1, a: ['backend'] } },
    { scope: 'global' as const, key: 'profile.summary', value: 'safe summary' },
  ],
});

describe('NovaWing host context boundary', () => {
  it('reads global/career exactly once and deterministically sorts/clones entries', () => {
    const fake = new FakeNovaWingHostAdapter(context());
    const frozen = readFrozenNovaWingContext(fake);
    expect(fake.calls).toEqual([{ scopes: ['global', 'career'] }]);
    expect(frozen).toEqual({
      coreRevision: 7,
      scopes: ['global', 'career'],
      entries: [
        { scope: 'global', key: 'profile.summary', value: 'safe summary' },
        { scope: 'career', key: 'target.role', value: { a: ['backend'], z: 1 } },
      ],
    });
  });

  it.each([
    [{ coreRevision: 1.5, entries: [] }, 'revision'],
    [{ coreRevision: -1, entries: [] }, 'revision'],
    [{ coreRevision: 1, entries: [{ scope: 'other', key: 'x', value: 1 }] }, 'scope'],
    [{ coreRevision: 1, entries: [
      { scope: 'global', key: 'x', value: 1 },
      { scope: 'global', key: ' x ', value: 2 },
    ] }, '重复'],
    [{ coreRevision: 1, entries: [{ scope: 'global', key: 'accessToken', value: 'redacted' }] }, '不安全'],
    [{ coreRevision: 1, entries: [{ scope: 'global', key: 'x', value: Number.NaN }] }, '有限数字'],
    [{ coreRevision: 1, entries: [], databasePath: 'hidden' }, '未知字段'],
    [{ coreRevision: 1, entries: [{ scope: 'global', key: 'x', value: 1, extra: true }] }, '未知字段'],
  ])('rejects invalid runtime projection %#', (raw, message) => {
    expect(() => normalizeNovaWingContext(raw)).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_CONTEXT_INVALID',
      message: expect.stringContaining(message),
    }));
  });

  it('rejects forbidden content without echoing the value', () => {
    const secretPath = 'C:\\private\\profile.sqlite';
    try {
      normalizeNovaWingContext({
        coreRevision: 1,
        entries: [{ scope: 'global', key: 'safe', value: secretPath }],
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(NovaWingContextError);
      expect((error as NovaWingContextError).code).toBe('NOVA_WING_CONTEXT_INVALID');
      expect((error as Error).message).not.toContain(secretPath);
    }
  });

  it('returns stable missing/unavailable/too-large errors with redacted messages', () => {
    expect(() => readFrozenNovaWingContext(undefined)).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_ADAPTER_REQUIRED',
    }));

    const fake = new FakeNovaWingHostAdapter(context());
    fake.setUnavailable(new Error('SQLITE_BUSY C:\\private\\real.sqlite token=secret'));
    expect(() => readFrozenNovaWingContext(fake)).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_CONTEXT_UNAVAILABLE',
      message: 'NovaWing 分析上下文暂不可用',
    }));

    fake.setOversizedContext();
    expect(() => readFrozenNovaWingContext(fake)).toThrowError(expect.objectContaining({
      code: 'NOVA_WING_CONTEXT_TOO_LARGE',
    }));
  });
});
