import { canonicalJson } from '../../job-memory/requestHash';
import { scanForbiddenContent } from './safetyScan';
import {
  NOVA_WING_ANALYSIS_SCOPES,
  type NovaWingHostAdapter,
  type NovaWingMainlineContext,
  type NovaWingMainlineScope,
} from './novaWingHostAdapter';

export const NOVA_WING_CONTEXT_MAX_BYTES = 32 * 1024;

export const NOVA_WING_CONTEXT_ERROR_CODES = [
  'NOVA_WING_CONTEXT_UNAVAILABLE',
  'NOVA_WING_CONTEXT_INVALID',
  'NOVA_WING_CONTEXT_TOO_LARGE',
  'NOVA_WING_ADAPTER_REQUIRED',
] as const;
export type NovaWingContextErrorCode = (typeof NOVA_WING_CONTEXT_ERROR_CODES)[number];

export class NovaWingContextError extends Error {
  constructor(readonly code: NovaWingContextErrorCode, message: string) {
    super(message);
    this.name = 'NovaWingContextError';
  }
}

export type NovaWingSafeValue =
  | null
  | boolean
  | number
  | string
  | NovaWingSafeValue[]
  | { [key: string]: NovaWingSafeValue };

export interface FrozenNovaWingMainlineEntry {
  scope: NovaWingMainlineScope;
  key: string;
  value: NovaWingSafeValue;
}

export interface FrozenNovaWingAnalysisContext {
  coreRevision: number;
  scopes: readonly ['global', 'career'];
  entries: readonly FrozenNovaWingMainlineEntry[];
}

const KEY_MAX_LENGTH = 160;
const STRING_MAX_LENGTH = 8_000;
const COLLECTION_MAX_ITEMS = 500;
const VALUE_MAX_DEPTH = 12;
const FORBIDDEN_KEY = /(authorization|cookie|password|secret|token|prompt|credential|api.?key|private.?key|absolute.?path|database.?path|^__proto__$|^prototype$|^constructor$)/i;
const SCOPE_RANK: Record<NovaWingMainlineScope, number> = { global: 0, career: 1 };
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function invalidContext(message: string): never {
  throw new NovaWingContextError('NOVA_WING_CONTEXT_INVALID', message);
}

function normalizeSafeValue(value: unknown, depth: number, seen: Set<object>): NovaWingSafeValue {
  if (depth > VALUE_MAX_DEPTH) invalidContext('NovaWing Context 值嵌套过深');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > STRING_MAX_LENGTH) {
      invalidContext('NovaWing Context 字符串超过安全上限');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidContext('NovaWing Context 只允许有限数字');
    return value;
  }
  if (typeof value !== 'object') invalidContext('NovaWing Context 只允许 JSON 安全值');

  const objectValue = value as object;
  if (seen.has(objectValue)) invalidContext('NovaWing Context 不允许循环引用');
  seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      if (value.length > COLLECTION_MAX_ITEMS) invalidContext('NovaWing Context 数组条目过多');
      return value.map((item) => normalizeSafeValue(item, depth + 1, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidContext('NovaWing Context 只允许普通 JSON 对象');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > COLLECTION_MAX_ITEMS) invalidContext('NovaWing Context 对象字段过多');
    const normalized: Record<string, NovaWingSafeValue> = {};
    for (const [key, nested] of entries.sort(([a], [b]) => compareText(a, b))) {
      if (key.length === 0 || key.length > KEY_MAX_LENGTH || FORBIDDEN_KEY.test(key)) {
        invalidContext('NovaWing Context 包含不安全字段名');
      }
      normalized[key] = normalizeSafeValue(nested, depth + 1, seen);
    }
    return normalized;
  } finally {
    seen.delete(objectValue);
  }
}

function isScope(value: unknown): value is NovaWingMainlineScope {
  return value === 'global' || value === 'career';
}

/** Validate, sanitize, clone, and deterministically order an adapter projection. */
export function normalizeNovaWingContext(value: unknown): FrozenNovaWingAnalysisContext {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidContext('NovaWing Context 结构无效');
  }
  const rootPrototype = Object.getPrototypeOf(value);
  if (rootPrototype !== Object.prototype && rootPrototype !== null) {
    invalidContext('NovaWing Context 只允许普通对象');
  }
  const rootKeys = Object.keys(value as object);
  if (rootKeys.some((key) => key !== 'coreRevision' && key !== 'entries')) {
    invalidContext('NovaWing Context 包含未知字段');
  }
  const raw = value as Partial<NovaWingMainlineContext>;
  if (!Number.isSafeInteger(raw.coreRevision) || (raw.coreRevision as number) < 0) {
    invalidContext('NovaWing Context revision 必须是非负安全整数');
  }
  if (!Array.isArray(raw.entries)) invalidContext('NovaWing Context entries 必须是数组');
  if (raw.entries.length > COLLECTION_MAX_ITEMS) invalidContext('NovaWing Context entries 过多');

  const seenKeys = new Set<string>();
  const entries: FrozenNovaWingMainlineEntry[] = Array.from(raw.entries, (entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return invalidContext('NovaWing Context entry 结构无效');
    }
    const entryPrototype = Object.getPrototypeOf(entry);
    if (entryPrototype !== Object.prototype && entryPrototype !== null) {
      return invalidContext('NovaWing Context entry 只允许普通对象');
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.some((key) => key !== 'scope' && key !== 'key' && key !== 'value')) {
      return invalidContext('NovaWing Context entry 包含未知字段');
    }
    const rawEntry = entry as { scope?: unknown; key?: unknown; value?: unknown };
    if (!isScope(rawEntry.scope)) invalidContext('NovaWing Context entry scope 无效');
    if (typeof rawEntry.key !== 'string') invalidContext('NovaWing Context entry key 无效');
    const key = rawEntry.key.trim();
    if (key.length === 0 || key.length > KEY_MAX_LENGTH || FORBIDDEN_KEY.test(key)) {
      invalidContext('NovaWing Context entry key 不安全');
    }
    const identity = `${rawEntry.scope}\u0000${key}`;
    if (seenKeys.has(identity)) invalidContext('NovaWing Context 包含重复 scope/key');
    seenKeys.add(identity);
    return {
      scope: rawEntry.scope,
      key,
      value: normalizeSafeValue(rawEntry.value, 0, new Set<object>()),
    };
  });
  entries.sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || compareText(a.key, b.key));

  const normalized: FrozenNovaWingAnalysisContext = {
    coreRevision: raw.coreRevision as number,
    scopes: NOVA_WING_ANALYSIS_SCOPES,
    entries,
  };
  if (scanForbiddenContent(normalized, '$.novaWingContext').length > 0) {
    invalidContext('NovaWing Context 包含禁止内容');
  }
  const bytes = Buffer.byteLength(canonicalJson(normalized), 'utf8');
  if (bytes > NOVA_WING_CONTEXT_MAX_BYTES) {
    throw new NovaWingContextError(
      'NOVA_WING_CONTEXT_TOO_LARGE',
      `NovaWing Context 超过 ${NOVA_WING_CONTEXT_MAX_BYTES} 字节安全上限`,
    );
  }
  return normalized;
}

/** Read exactly once and map all adapter failures to stable, redacted application errors. */
export function readFrozenNovaWingContext(adapter: NovaWingHostAdapter | undefined): FrozenNovaWingAnalysisContext {
  if (adapter === undefined) {
    throw new NovaWingContextError('NOVA_WING_ADAPTER_REQUIRED', '已启用 NovaWing 分析上下文，但未注入宿主适配器');
  }
  let value: unknown;
  try {
    value = adapter.readLatestMainline({ scopes: NOVA_WING_ANALYSIS_SCOPES });
  } catch {
    throw new NovaWingContextError('NOVA_WING_CONTEXT_UNAVAILABLE', 'NovaWing 分析上下文暂不可用');
  }
  try {
    return normalizeNovaWingContext(value);
  } catch (error) {
    if (error instanceof NovaWingContextError) throw error;
    throw new NovaWingContextError('NOVA_WING_CONTEXT_INVALID', 'NovaWing Context 结构无效');
  }
}
