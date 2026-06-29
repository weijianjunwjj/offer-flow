export type StorageRuntimeKind = 'web' | 'tauri';

export interface StorageRuntime {
  kind: StorageRuntimeKind;
  isTauri: boolean;
}

export function detectStorageRuntime(): StorageRuntime {
  const globalScope = globalThis as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
    window?: {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
    };
  };
  const windowScope =
    typeof window === 'undefined'
      ? globalScope.window
      : (window as typeof globalScope.window);
  const isTauri = Boolean(
    globalScope.__TAURI_INTERNALS__ ??
      globalScope.__TAURI__ ??
      windowScope?.__TAURI_INTERNALS__ ??
      windowScope?.__TAURI__,
  );

  return {
    kind: isTauri ? 'tauri' : 'web',
    isTauri,
  };
}
