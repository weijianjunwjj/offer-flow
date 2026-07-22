/**
 * Radar 采集会话 capability（sessionId）的读取/持久化/清理纯逻辑。
 *
 * 目的（§三）：sessionId 是短期 capability，虽然位于 hash fragment 不会发给服务端，
 * 但会残留在地址栏、浏览器历史与截图中。因此：
 * - 首次从 route query 读取并校验格式；
 * - 保存到 sessionStorage（不用 localStorage）；
 * - 立即从地址栏清除完整 sessionId，仍停留在 /radar/import；
 * - 刷新后可从 sessionStorage 恢复；
 * - committed/cancelled/expired/invalid 后删除 sessionStorage 中的 capability；
 * - 只暴露截断后的会话标识，绝不打印完整 sessionId。
 *
 * 逻辑抽成纯函数便于单测，Vue 组件只做装配。
 */

const STORAGE_KEY = 'offerflow.radar.captureSessionId';

/** 会话 ID 由 node:crypto randomUUID 生成，这里按 UUID v4 形状做保守校验，非法值不持久化。 */
const SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** 只用于 UI 展示/日志的截断标识，绝不暴露完整 capability。 */
export function truncateSessionId(sessionId: string): string {
  return isValidSessionId(sessionId) ? `${sessionId.slice(0, 8)}…` : '（无效会话）';
}

export function persistSessionId(storage: SessionStorageLike, sessionId: string): void {
  if (!isValidSessionId(sessionId)) return;
  storage.setItem(STORAGE_KEY, sessionId);
}

export function readPersistedSessionId(storage: SessionStorageLike): string | null {
  const stored = storage.getItem(STORAGE_KEY);
  return isValidSessionId(stored) ? stored : null;
}

export function clearPersistedSessionId(storage: SessionStorageLike): void {
  storage.removeItem(STORAGE_KEY);
}

export interface ResolveSessionInput {
  /** 来自 route query / hash 的原始 sessionId（可能为空或非法）。 */
  querySessionId: string | null | undefined;
  storage: SessionStorageLike;
}

export interface ResolveSessionResult {
  sessionId: string | null;
  /** 本次是否来自地址栏 query（用于决定是否需要清除地址栏）。 */
  fromQuery: boolean;
}

/**
 * 解析本次会话：优先用地址栏 query（合法则持久化），否则回退 sessionStorage。
 * 非法 query 不持久化、也不覆盖已有存储。
 */
export function resolveSessionId(input: ResolveSessionInput): ResolveSessionResult {
  const { querySessionId, storage } = input;
  if (isValidSessionId(querySessionId)) {
    persistSessionId(storage, querySessionId);
    return { sessionId: querySessionId, fromQuery: true };
  }
  return { sessionId: readPersistedSessionId(storage), fromQuery: false };
}

/** 会话终态后是否应清除 capability。 */
export function shouldClearOnStatus(status: string | null | undefined): boolean {
  return status === 'committed' || status === 'cancelled' || status === 'expired';
}

/**
 * 从 hash（形如 `#/radar/import?sessionId=...&x=1`）中移除完整 sessionId 参数，
 * 保留路径与其它参数，仍停留在 /radar/import。用于清理地址栏中的 capability。
 */
export function stripSessionIdFromHash(hash: string): string {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return `#${withoutHash}`;
  const path = withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(withoutHash.slice(queryIndex + 1));
  params.delete('sessionId');
  const rest = params.toString();
  return rest.length > 0 ? `#${path}?${rest}` : `#${path}`;
}
