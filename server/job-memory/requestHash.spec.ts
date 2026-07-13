import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256RequestHash } from './requestHash';

describe('Job Memory request hash', () => {
  it('稳定排序对象键但保留数组顺序', () => {
    const left = { z: 1, nested: { b: true, a: null }, list: ['a', 'b'] };
    const reordered = { list: ['a', 'b'], nested: { a: null, b: true }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(reordered));
    expect(sha256RequestHash(left)).toBe(sha256RequestHash(reordered));
    expect(sha256RequestHash(left)).not.toBe(sha256RequestHash({ ...left, list: ['b', 'a'] }));
  });

  it('拒绝 undefined 和非有限数字', () => {
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/非有限数字/);
  });
});
