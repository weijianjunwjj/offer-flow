// 浏览器端 stores 单例。延迟创建，避免在模块加载时就访问 localStorage，
// 便于在非浏览器环境（如类型检查 / 未来测试）下按需注入。
import { createBrowserStores } from '../storage';
import {
  createLocalStorageAsyncStores,
  createSQLiteAsyncStores,
  resolveStorageBackend,
} from '../storage';
import type {
  AsyncOfferFlowStores,
  OfferFlowStores,
  SQLiteClient,
  SQLiteMigrationStatusClient,
  StorageBackend,
  StorageBackendResolution,
  StorageDriver,
  StorageRuntime,
} from '../storage';

let cached: OfferFlowStores | null = null;

export function useStores(): OfferFlowStores {
  if (cached === null) {
    cached = createBrowserStores();
  }
  return cached;
}

export interface AsyncStoreFactoryOptions {
  backend?: StorageBackend;
  storageDriver?: StorageDriver;
  sqliteClient?: SQLiteClient;
}

export interface StorageBackendBootstrapOptions {
  storageDriver: StorageDriver;
  runtime?: StorageRuntime;
  sqliteClient?: SQLiteClient & SQLiteMigrationStatusClient;
}

export interface StorageBackendBootstrapResult {
  resolution: StorageBackendResolution;
  stores: AsyncOfferFlowStores;
}

export function createAsyncStores(
  options: AsyncStoreFactoryOptions = {},
): AsyncOfferFlowStores {
  const backend = options.backend ?? 'localStorage';
  if (backend === 'sqlite') {
    return createSQLiteAsyncStores(options.sqliteClient);
  }
  return createLocalStorageAsyncStores(options.storageDriver);
}

export async function initializeStorageBackend(
  options: StorageBackendBootstrapOptions,
): Promise<StorageBackendBootstrapResult> {
  const resolution = await resolveStorageBackend({
    driver: options.storageDriver,
    runtime: options.runtime,
    sqliteClient: options.sqliteClient,
  });
  const stores = createAsyncStores({
    backend: resolution.activeBackend,
    storageDriver: options.storageDriver,
    sqliteClient: options.sqliteClient,
  });

  return { resolution, stores };
}
