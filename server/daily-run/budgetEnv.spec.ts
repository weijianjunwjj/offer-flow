/**
 * v0.9 — Daily Job Hunter budget env override 测试。
 */
import { describe, expect, it } from 'vitest';
import {
  DAILY_ENRICHMENT_BUDGET_MAX,
  DAILY_FETCH_BUDGET_MAX,
  ENV_ENRICHMENT_BUDGET,
  ENV_FETCH_BUDGET,
  parseBudgetEnv,
  resolveDailyBudgetOverrides,
} from './budgetEnv';

describe('parseBudgetEnv', () => {
  it('缺失 / 空 / 空白 → undefined', () => {
    expect(parseBudgetEnv(undefined, 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('   ', 'K', 50)).toBeUndefined();
  });

  it('合法非负整数 → number', () => {
    expect(parseBudgetEnv('5', 'K', 50)).toBe(5);
    expect(parseBudgetEnv(' 5 ', 'K', 50)).toBe(5);
  });

  it('0 合法', () => {
    expect(parseBudgetEnv('0', 'K', 50)).toBe(0);
  });

  it('非数字 / 小数 / 负数 / 符号 / 科学计数 → undefined', () => {
    expect(parseBudgetEnv('abc', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('3.5', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('-1', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('+5', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('1e3', 'K', 50)).toBeUndefined();
    expect(parseBudgetEnv('5x', 'K', 50)).toBeUndefined();
  });

  it('超上限 → clamp 到 max', () => {
    expect(parseBudgetEnv('51', 'K', 50)).toBe(50);
    expect(parseBudgetEnv('999', 'K', 50)).toBe(50);
    expect(parseBudgetEnv('21', 'K', 20)).toBe(20);
  });

  it('超安全整数 → undefined（回退默认）', () => {
    expect(parseBudgetEnv('999999999999999999999999', 'K', 50)).toBeUndefined();
  });
});

describe('resolveDailyBudgetOverrides', () => {
  it('env 未设置 → 空对象（coordinator 不覆盖默认预算）', () => {
    expect(resolveDailyBudgetOverrides({})).toEqual({});
  });

  it('FETCH=5 / ENRICHMENT=3 → 5 / 3', () => {
    expect(resolveDailyBudgetOverrides({
      [ENV_FETCH_BUDGET]: '5',
      [ENV_ENRICHMENT_BUDGET]: '3',
    })).toEqual({ fetchBudget: 5, enrichmentBudget: 3 });
  });

  it('0 → 合法传入 0', () => {
    expect(resolveDailyBudgetOverrides({
      [ENV_FETCH_BUDGET]: '0',
      [ENV_ENRICHMENT_BUDGET]: '0',
    })).toEqual({ fetchBudget: 0, enrichmentBudget: 0 });
  });

  it('非法字符串 → 回退 undefined（不含 key）', () => {
    expect(resolveDailyBudgetOverrides({
      [ENV_FETCH_BUDGET]: 'abc',
      [ENV_ENRICHMENT_BUDGET]: '3.5',
    })).toEqual({});
  });

  it('负数 / 小数 → 回退 undefined', () => {
    expect(resolveDailyBudgetOverrides({
      [ENV_FETCH_BUDGET]: '-5',
      [ENV_ENRICHMENT_BUDGET]: '2.5',
    })).toEqual({});
  });

  it('超上限 → clamp 到各自 max', () => {
    expect(resolveDailyBudgetOverrides({
      [ENV_FETCH_BUDGET]: '999',
      [ENV_ENRICHMENT_BUDGET]: '999',
    })).toEqual({ fetchBudget: DAILY_FETCH_BUDGET_MAX, enrichmentBudget: DAILY_ENRICHMENT_BUDGET_MAX });
  });
});
