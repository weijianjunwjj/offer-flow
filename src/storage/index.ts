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

export interface OfferPilotStores {
  config: ConfigStore;
  jobs: JobStore;
}

/** Build stores on top of any driver you hand in. */
export function createStores(driver: StorageDriver): OfferPilotStores {
  return { config: new ConfigStore(driver), jobs: new JobStore(driver) };
}

/** Real app (browser, localStorage). */
export function createBrowserStores(): OfferPilotStores {
  return createStores(new BrowserStorageDriver());
}

/** Tests / Node (in-memory). */
export function createMemoryStores(): OfferPilotStores {
  return createStores(new MemoryStorageDriver());
}
