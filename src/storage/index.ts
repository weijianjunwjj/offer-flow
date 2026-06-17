// Public surface of the Step 0 storage layer.

export * from './types';
export * from './keys';

export { MemoryStorageDriver, BrowserStorageDriver } from './driver';
export type { StorageDriver } from './driver';

export { ConfigStore } from './configStore';
export { JobStore } from './jobStore';

import type { StorageDriver } from './driver';
import { BrowserStorageDriver, MemoryStorageDriver } from './driver';
import { ConfigStore } from './configStore';
import { JobStore } from './jobStore';
import { migrateLegacyStorageNamespace } from './migration';

export interface OfferFlowStores {
  config: ConfigStore;
  jobs: JobStore;
}

/** Build stores on top of any driver you hand in. */
export function createStores(driver: StorageDriver): OfferFlowStores {
  migrateLegacyStorageNamespace(driver);
  return { config: new ConfigStore(driver), jobs: new JobStore(driver) };
}

/** Real app (browser, localStorage). */
export function createBrowserStores(): OfferFlowStores {
  return createStores(new BrowserStorageDriver());
}

/** Tests / Node (in-memory). */
export function createMemoryStores(): OfferFlowStores {
  return createStores(new MemoryStorageDriver());
}
