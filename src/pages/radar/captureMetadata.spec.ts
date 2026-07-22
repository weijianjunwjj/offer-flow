import { describe, expect, it } from 'vitest';
import { readCapturedActivityStatus } from './captureMetadata';

describe('captureMetadata — 招聘者采集时活跃状态', () => {
  it('优先读取顶层快照值，并兼容 fields provenance', () => {
    expect(readCapturedActivityStatus({ activityStatus: '刚刚活跃' })).toBe('刚刚活跃');
    expect(readCapturedActivityStatus({ fields: { activityStatus: { value: '3日内活跃' } } })).toBe('3日内活跃');
  });

  it('缺失、非字符串与超长值保持未知', () => {
    expect(readCapturedActivityStatus(null)).toBeNull();
    expect(readCapturedActivityStatus({ activityStatus: 3 })).toBeNull();
    expect(readCapturedActivityStatus({ activityStatus: '活'.repeat(31) })).toBeNull();
  });
});
