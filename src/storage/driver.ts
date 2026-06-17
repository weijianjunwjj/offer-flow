// The single seam between our stores and where bytes actually live.
// Real app -> localStorage. Tests / Node -> an in-memory map.
// This is a test seam, not a feature: it lets Step 0 self-test without a browser.

export interface StorageDriver {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

/** In-memory driver — used by the self-test and any non-browser context. */
export class MemoryStorageDriver implements StorageDriver {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** localStorage-backed driver — used by the real app in the browser. */
export class BrowserStorageDriver implements StorageDriver {
  private readonly store: Storage;

  constructor(store?: Storage) {
    const candidate =
      store ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
    if (!candidate) {
      throw new Error('[OfferFlow] localStorage is not available in this environment.');
    }
    this.store = candidate;
  }

  getItem(key: string): string | null {
    return this.store.getItem(key);
  }

  setItem(key: string, value: string): void {
    this.store.setItem(key, value);
  }

  removeItem(key: string): void {
    this.store.removeItem(key);
  }

  keys(): string[] {
    const result: string[] = [];
    for (let i = 0; i < this.store.length; i += 1) {
      const key = this.store.key(i);
      if (key !== null) {
        result.push(key);
      }
    }
    return result;
  }
}
