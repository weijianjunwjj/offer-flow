import { createHash } from 'node:crypto';

function canonicalize(value: unknown, path: string): unknown {
  if (value === undefined) {
    throw new TypeError(`规范化数据不得包含 undefined：${path}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested, `${path}.${key}`)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`规范化数据不得包含非有限数字：${path}`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, '$'));
}

export function sha256RequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
