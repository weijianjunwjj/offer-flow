import { NovaWingError, type NovaWingFacade } from '@weijianjunwjj/nova-wing/core';
import { describe, expect, it } from 'vitest';
import { NovaWingRuntimeAdapter } from './runtimeAdapter';

function facadeWithGetContext(
  getContext: NovaWingFacade['getContext'],
): NovaWingFacade {
  return { getContext } as NovaWingFacade;
}

describe('NovaWingRuntimeAdapter', () => {
  it('maps the public facade context to the minimal OfferFlow projection', () => {
    const facade = facadeWithGetContext(() => ({
      coreRevision: 3,
      entries: [{
        id: 'entry-private-id',
        memoryKey: 'global.runtime_contract',
        operation: 'set',
        category: 'principle',
        assertionType: 'user_decision',
        scope: 'global',
        statement: 'Prefer immutable package consumption',
        rationale: 'Stable host integration',
        supersedesEntryId: null,
        sourceProposalId: 'proposal-private-id',
        coreRevision: 3,
        createdAt: '2026-08-05T00:00:00.000Z',
      }],
    }));
    const adapter = new NovaWingRuntimeAdapter({
      facade,
      busyRetries: 1,
      busyRetryDelayMs: 0,
    });

    expect(adapter.readLatestMainline({ scopes: ['global', 'career'] })).toEqual({
      coreRevision: 3,
      entries: [{
        scope: 'global',
        key: 'global.runtime_contract',
        value: {
          assertionType: 'user_decision',
          category: 'principle',
          rationale: 'Stable host integration',
          statement: 'Prefer immutable package consumption',
        },
      }],
    });
  });

  it('retries STORE_BUSY finitely and succeeds after the lock clears', () => {
    let calls = 0;
    const facade = facadeWithGetContext(() => {
      calls += 1;
      if (calls === 1) throw new NovaWingError('STORE_BUSY', 'raw busy detail');
      return { coreRevision: 1, entries: [] };
    });
    const adapter = new NovaWingRuntimeAdapter({
      facade,
      busyRetries: 1,
      busyRetryDelayMs: 0,
    });

    expect(adapter.readLatestMainline({ scopes: ['global', 'career'] })).toEqual({
      coreRevision: 1,
      entries: [],
    });
    expect(calls).toBe(2);
  });

  it('maps terminal failures without leaking SQLite text or paths', () => {
    const secret = 'SQLITE_BUSY C:\\private\\business.sqlite';
    const facade = facadeWithGetContext(() => {
      throw new NovaWingError('STORE_BUSY', secret);
    });
    const adapter = new NovaWingRuntimeAdapter({
      facade,
      busyRetries: 0,
      busyRetryDelayMs: 0,
    });

    try {
      adapter.readLatestMainline({ scopes: ['global', 'career'] });
      throw new Error('expected unavailable error');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'NOVA_WING_CONTEXT_UNAVAILABLE',
        message: 'NovaWing 分析上下文暂不可用',
      });
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('SQLite');
    }
  });
});
