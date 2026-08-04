/**
 * gatewayConfig 测试：预算解析、价格表完整性。
 */
import { describe, expect, it } from 'vitest';
import { parseUserBudgetOverride, DEFAULT_GATEWAY_CONFIG } from './gatewayConfig';

describe('parseUserBudgetOverride', () => {
  it('解析"预算上限：0.50 元"', () => {
    const result = parseUserBudgetOverride('修改文案：把按钮文字改成"确认投递"\n预算上限：0.50 元');
    expect(result).toBeDefined();
    expect(result!.amountRmb).toBe(0.50);
  });

  it('解析"预算上限：0.50"（省略"元"）', () => {
    const result = parseUserBudgetOverride('预算上限：0.50');
    expect(result).toBeDefined();
    expect(result!.amountRmb).toBe(0.50);
  });

  it('解析"预算上限: 1.5元"（英文冒号）', () => {
    const result = parseUserBudgetOverride('调整架构\n预算上限: 1.5元');
    expect(result).toBeDefined();
    expect(result!.amountRmb).toBe(1.5);
  });

  it('不含预算覆盖时返回 undefined', () => {
    const result = parseUserBudgetOverride('修改文案：调整按钮颜色');
    expect(result).toBeUndefined();
  });

  it('金额为 0 或负数时返回 undefined', () => {
    expect(parseUserBudgetOverride('预算上限：0 元')).toBeUndefined();
    expect(parseUserBudgetOverride('预算上限：-1 元')).toBeUndefined();
  });

  it('小数精度保留到分', () => {
    const result = parseUserBudgetOverride('预算上限：0.1234 元');
    expect(result?.amountRmb).toBe(0.12);
  });
});

describe('DEFAULT_GATEWAY_CONFIG', () => {
  it('只绑定 127.0.0.1', () => {
    expect(DEFAULT_GATEWAY_CONFIG.host).toBe('127.0.0.1');
  });

  it('包含 DeepSeek V4 Pro 价格', () => {
    expect(DEFAULT_GATEWAY_CONFIG.modelPricing['deepseek-v4-pro']).toBeDefined();
  });

  it('包含 DeepSeek V4 Flash 价格', () => {
    expect(DEFAULT_GATEWAY_CONFIG.modelPricing['deepseek-v4-flash']).toBeDefined();
  });

  it('包含原第三方模型价格', () => {
    expect(DEFAULT_GATEWAY_CONFIG.modelPricing['claude-sonnet-5']).toBeDefined();
    expect(DEFAULT_GATEWAY_CONFIG.modelPricing['claude-haiku-4-5']).toBeDefined();
  });

  it('冷启动静态估计存在', () => {
    const est = DEFAULT_GATEWAY_CONFIG.coldStartEstimates;
    expect(est.simple.centerRmb).toBeGreaterThan(0);
    expect(est.normal.centerRmb).toBeGreaterThan(0);
    expect(est.complex.centerRmb).toBeGreaterThan(0);
  });
});
