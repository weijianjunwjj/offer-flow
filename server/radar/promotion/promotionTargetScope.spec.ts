import { describe, expect, it } from 'vitest';
import { computeTargetScopeKey } from './promotionTargetScope';

describe('V8-6 目标范围键', () => {
  it('相同业务身份 → 同键', () => {
    const a = computeTargetScopeKey({ company: '同城科技', role: '前端工程师', city: '苏州' });
    const b = computeTargetScopeKey({ company: '同城科技', role: '前端工程师', city: '苏州' });
    expect(a).toBe(b);
  });

  it('大小写与首尾空白不影响键（避免抓取噪音造成重复正式对象）', () => {
    const a = computeTargetScopeKey({ company: 'ACME', role: 'Frontend', city: 'Suzhou' });
    const b = computeTargetScopeKey({ company: '  acme ', role: ' frontend', city: 'suzhou  ' });
    expect(a).toBe(b);
  });

  it('空串与 null 归一为同键', () => {
    const a = computeTargetScopeKey({ company: '', role: '   ', city: null });
    const b = computeTargetScopeKey({ company: null, role: null, city: null });
    expect(a).toBe(b);
  });

  it('公司/岗位/城市任一不同 → 不同键', () => {
    const base = { company: '同城科技', role: '前端工程师', city: '苏州' };
    const keys = new Set([
      computeTargetScopeKey(base),
      computeTargetScopeKey({ ...base, company: '越迁软件' }),
      computeTargetScopeKey({ ...base, role: '后端工程师' }),
      computeTargetScopeKey({ ...base, city: '上海' }),
    ]);
    expect(keys.size).toBe(4);
  });

  it('字段错位不产生相同键（company/role 互换应不同）', () => {
    const a = computeTargetScopeKey({ company: 'x', role: 'y', city: null });
    const b = computeTargetScopeKey({ company: 'y', role: 'x', city: null });
    expect(a).not.toBe(b);
  });

  it('键带版本化前缀', () => {
    expect(computeTargetScopeKey({ company: 'a', role: 'b', city: 'c' }))
      .toMatch(/^radar-promotion-scope:v1:[0-9a-f]{64}$/);
  });
});
