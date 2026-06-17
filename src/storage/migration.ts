import type { StorageDriver } from './driver';
import { LEGACY_NAMESPACE, legacyKeyToCurrentKey } from './keys';

export function migrateLegacyStorageNamespace(driver: StorageDriver): void {
  for (const key of driver.keys()) {
    if (!key.startsWith(LEGACY_NAMESPACE)) {
      continue;
    }
    const nextKey = legacyKeyToCurrentKey(key);
    if (nextKey === null || driver.getItem(nextKey) !== null) {
      continue;
    }
    const value = driver.getItem(key);
    if (value !== null) {
      driver.setItem(nextKey, value);
    }
  }
}
