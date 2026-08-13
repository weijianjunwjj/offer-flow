/**
 * OfferFlow v0.9 — SecretStore tests.
 *
 * Task: T025
 *
 * Covers:
 *  - EnvSecretStore: store / resolve / delete
 *  - MemorySecretStore: store / resolve / delete / isolation
 *  - Error cases: unknown ref, invalid ref, missing env var
 *
 * Note: Current SecretStore implementations are synchronous. When async
 * implementations are added (e.g. WindowsDpapiSecretStore), tests should
 * be updated to handle Promise-based methods.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvSecretStore } from './EnvSecretStore';
import { MemorySecretStore } from './MemorySecretStore';

// ── Shared test suite ────────────────────────────────────────────────────────

function runSecretStoreTests(
  label: string,
  factory: () => { resolve(ref: string): string; store(key: string, secret: string): string; delete(ref: string): void },
  cleanup?: () => void,
): void {
  describe(label, () => {
    let store: ReturnType<typeof factory>;

    beforeEach(() => {
      store = factory();
    });

    afterEach(() => {
      cleanup?.();
    });

    it('store() returns a ref and resolve() returns the secret', () => {
      const ref = store.store('TAVILY_API_KEY', 'tvly-secret-123');
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
      expect(store.resolve(ref)).toBe('tvly-secret-123');
    });

    it('resolve() throws on unknown ref', () => {
      expect(() => store.resolve('bogus-ref')).toThrow();
    });

    it('delete() removes the secret', () => {
      const ref = store.store('KEY', 'value');
      store.delete(ref);
      expect(() => store.resolve(ref)).toThrow();
    });

    it('delete() throws on unknown ref', () => {
      expect(() => store.delete('bogus-ref')).toThrow();
    });

    it('multiple secrets are independent', () => {
      const refA = store.store('KEY_A', 'value-a');
      const refB = store.store('KEY_B', 'value-b');

      expect(store.resolve(refA)).toBe('value-a');
      expect(store.resolve(refB)).toBe('value-b');

      store.delete(refA);
      expect(() => store.resolve(refA)).toThrow();
      expect(store.resolve(refB)).toBe('value-b');
    });

    it('re-storing same key returns different refs', () => {
      const ref1 = store.store('KEY', 'v1');
      const ref2 = store.store('KEY', 'v2');
      expect(ref1).not.toBe(ref2);
    });

    it('each ref resolves to its own value', () => {
      const ref1 = store.store('KEY', 'v1');
      const ref2 = store.store('KEY', 'v2');
      expect(store.resolve(ref1)).toBe('v1');
      expect(store.resolve(ref2)).toBe('v2');
    });
  });
}

// ── MemorySecretStore ────────────────────────────────────────────────────────

runSecretStoreTests('MemorySecretStore', () => new MemorySecretStore());

describe('MemorySecretStore (extra)', () => {
  it('size tracks stored count', () => {
    const store = new MemorySecretStore();
    expect(store.size).toBe(0);
    store.store('A', '1');
    expect(store.size).toBe(1);
    const ref = store.store('B', '2');
    expect(store.size).toBe(2);
    store.delete(ref);
    expect(store.size).toBe(1);
  });

  it('instances are isolated', () => {
    const s1 = new MemorySecretStore();
    const s2 = new MemorySecretStore();
    const ref = s1.store('K', 'v');
    expect(() => s2.resolve(ref)).toThrow();
  });
});

// ── EnvSecretStore ───────────────────────────────────────────────────────────

describe('EnvSecretStore', () => {
  it('resolve() reads from process.env via "env:" prefix', () => {
    process.env.TEST_SECRET_A = 'secret-value';
    try {
      const store = new EnvSecretStore();
      expect(store.resolve('env:TEST_SECRET_A')).toBe('secret-value');
    } finally {
      delete process.env.TEST_SECRET_A;
    }
  });

  it('resolve() throws when env var is missing', () => {
    const store = new EnvSecretStore();
    expect(() => store.resolve('env:NONEXISTENT_VAR_XYZ')).toThrow(
      'environment variable "NONEXISTENT_VAR_XYZ" is not set or empty',
    );
  });

  it('resolve() throws when env var is empty string', () => {
    process.env.TEST_EMPTY = '';
    try {
      const store = new EnvSecretStore();
      expect(() => store.resolve('env:TEST_EMPTY')).toThrow(
        'environment variable "TEST_EMPTY" is not set or empty',
      );
    } finally {
      delete process.env.TEST_EMPTY;
    }
  });

  it('resolve() throws for non-env: ref', () => {
    const store = new EnvSecretStore();
    expect(() => store.resolve('bogus:KEY')).toThrow('invalid secret ref');
  });

  it('store() sets process.env and returns ref', () => {
    const store = new EnvSecretStore();
    try {
      const ref = store.store('TEST_STORE_KEY', 'test-value');
      expect(ref).toBe('env:TEST_STORE_KEY');
      expect(process.env.TEST_STORE_KEY).toBe('test-value');
      expect(store.resolve(ref)).toBe('test-value');
    } finally {
      delete process.env.TEST_STORE_KEY;
    }
  });

  it('store() rejects keys with spaces', () => {
    const store = new EnvSecretStore();
    expect(() => store.store('KEY WITH SPACES', 'v')).toThrow(
      'must not contain spaces',
    );
  });

  it('delete() removes the env var', () => {
    process.env.TEST_DELETE_KEY = 'temp';
    const store = new EnvSecretStore();
    store.delete('env:TEST_DELETE_KEY');
    expect(process.env.TEST_DELETE_KEY).toBeUndefined();
  });

  it('delete() throws for non-env: ref', () => {
    const store = new EnvSecretStore();
    expect(() => store.delete('mem:KEY')).toThrow('invalid secret ref');
  });
});
