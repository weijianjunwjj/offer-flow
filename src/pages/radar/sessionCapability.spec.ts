import { describe, expect, it } from 'vitest';
import {
  clearPersistedSessionId,
  isValidSessionId,
  readPersistedSessionId,
  resolveSessionId,
  shouldClearOnStatus,
  stripSessionIdFromHash,
  truncateSessionId,
  type SessionStorageLike,
} from './sessionCapability';

const VALID = '452679bb-e371-48e3-bac7-66f349a5928b';

function fakeStorage(initial: Record<string, string> = {}): SessionStorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('sessionCapability', () => {
  it('reads a valid sessionId from the query on first load and persists it', () => {
    const storage = fakeStorage();
    const result = resolveSessionId({ querySessionId: VALID, storage });
    expect(result.sessionId).toBe(VALID);
    expect(result.fromQuery).toBe(true);
    expect(readPersistedSessionId(storage)).toBe(VALID);
  });

  it('strips the full sessionId from the address-bar hash, staying on /radar/import', () => {
    expect(stripSessionIdFromHash(`#/radar/import?sessionId=${VALID}`)).toBe('#/radar/import');
    // 保留其它参数
    expect(stripSessionIdFromHash(`#/radar/import?sessionId=${VALID}&debug=1`)).toBe('#/radar/import?debug=1');
    // 无 query 时原样返回
    expect(stripSessionIdFromHash('#/radar/import')).toBe('#/radar/import');
  });

  it('recovers the session from sessionStorage when no query is present (refresh case)', () => {
    const storage = fakeStorage({ 'offerflow.radar.captureSessionId': VALID });
    const result = resolveSessionId({ querySessionId: null, storage });
    expect(result.sessionId).toBe(VALID);
    expect(result.fromQuery).toBe(false);
  });

  it('clears the capability after committed / cancelled / expired', () => {
    for (const status of ['committed', 'cancelled', 'expired']) {
      expect(shouldClearOnStatus(status)).toBe(true);
      const storage = fakeStorage({ 'offerflow.radar.captureSessionId': VALID });
      clearPersistedSessionId(storage);
      expect(readPersistedSessionId(storage)).toBeNull();
    }
    expect(shouldClearOnStatus('preview')).toBe(false);
  });

  it('does NOT persist an invalid / guessed sessionId, and does not overwrite existing storage', () => {
    const storage = fakeStorage({ 'offerflow.radar.captureSessionId': VALID });
    const result = resolveSessionId({ querySessionId: 'not-a-uuid', storage });
    // 非法 query 不持久化、不覆盖，回退到已存储的合法值
    expect(result.sessionId).toBe(VALID);
    expect(result.fromQuery).toBe(false);
    expect(readPersistedSessionId(storage)).toBe(VALID);

    const empty = fakeStorage();
    resolveSessionId({ querySessionId: 'guessed-capability-0000', storage: empty });
    expect(readPersistedSessionId(empty)).toBeNull();
  });

  it('validates UUID shape and never surfaces the full id in the truncated label (§三.9)', () => {
    expect(isValidSessionId(VALID)).toBe(true);
    expect(isValidSessionId('nope')).toBe(false);
    const label = truncateSessionId(VALID);
    expect(label).toBe('452679bb…');
    expect(label).not.toContain(VALID);
    expect(label.length).toBeLessThan(VALID.length);
    expect(truncateSessionId('garbage')).toBe('（无效会话）');
  });
});
