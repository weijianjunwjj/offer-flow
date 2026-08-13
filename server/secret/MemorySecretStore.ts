/**
 * OfferFlow v0.9 — MemorySecretStore.
 *
 * Task: T025
 *
 * In-memory secret store backed by a Map. Suitable for unit tests.
 * Secrets are NOT encrypted and NOT persisted across restarts.
 *
 * Reference format: "mem:<random-id>"
 */

import type { SecretStore } from './SecretStore';

const PREFIX = 'mem:';

export class MemorySecretStore implements SecretStore {
  private readonly _map = new Map<string, string>();
  private _counter = 0;

  resolve(ref: string): string {
    const value = this._map.get(ref);
    if (value === undefined) {
      throw new Error(`MemorySecretStore: unknown secret ref "${ref}"`);
    }
    return value;
  }

  store(key: string, secret: string): string {
    const ref = `${PREFIX}${key}-${++this._counter}`;
    this._map.set(ref, secret);
    return ref;
  }

  delete(ref: string): void {
    if (!this._map.has(ref)) {
      throw new Error(`MemorySecretStore: unknown secret ref "${ref}"`);
    }
    this._map.delete(ref);
  }

  /** Returns the number of stored secrets (for test assertions). */
  get size(): number {
    return this._map.size;
  }
}
