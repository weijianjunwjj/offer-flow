import { describe, expect, it } from 'vitest';
import { features, readBooleanFeatureFlag } from './features';

describe('B4 前端统一 feature gate', () => {
  it('默认关闭 Job Memory v2 能力', () => {
    expect(features.jobMemoryV2Enabled).toBe(false);
  });

  it('只把显式 true 解析为开启', () => {
    expect(readBooleanFeatureFlag('true')).toBe(true);
    expect(readBooleanFeatureFlag(' TRUE ')).toBe(true);
    expect(readBooleanFeatureFlag(undefined)).toBe(false);
    expect(readBooleanFeatureFlag('1')).toBe(false);
    expect(readBooleanFeatureFlag('yes')).toBe(false);
  });
});
