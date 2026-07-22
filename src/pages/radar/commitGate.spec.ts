import { describe, expect, it } from 'vitest';
import {
  batchItemStatus, canCommit, committableConfirmedIndexes, isItemCommitBlocked, itemBlockingIssues,
  shouldDefaultConfirm, type CommitGateItem,
} from './commitGate';

function blocked(index: number, reason = '未定位到右侧当前岗位详情头部'): CommitGateItem {
  return { index, extractionMetadata: { commitBlocked: true, blockingIssues: [reason] } };
}

function ok(index: number): CommitGateItem {
  return { index, extractionMetadata: { commitBlocked: false } };
}

describe('commitGate — 确认写入闸门 (§九)', () => {
  it('识别 commitBlocked 与阻塞原因', () => {
    expect(isItemCommitBlocked(blocked(0))).toBe(true);
    expect(isItemCommitBlocked(ok(1))).toBe(false);
    expect(isItemCommitBlocked({ index: 2, extractionMetadata: null })).toBe(false);
    expect(itemBlockingIssues(blocked(0, '无法唯一绑定当前岗位'))).toEqual(['无法唯一绑定当前岗位']);
    expect(itemBlockingIssues(ok(1))).toEqual([]);
  });

  it('12. 全部条目 blocked 时无可提交条目，按钮应禁用', () => {
    const items = [blocked(0), blocked(1)];
    // 即使被误勾选，阻塞条目也不进入可提交集合。
    expect(committableConfirmedIndexes(items, [0, 1])).toEqual([]);
    expect(canCommit(items, [0, 1])).toBe(false);
  });

  it('13. 阻塞条目即使被勾选也从 commit payload 过滤（不发 commit / 不越界）', () => {
    const items = [blocked(0), ok(1), blocked(2)];
    expect(committableConfirmedIndexes(items, [0, 1, 2])).toEqual([1]);
    // 未知 index 不进入可提交集合。
    expect(committableConfirmedIndexes(items, [0, 2, 99])).toEqual([]);
    expect(canCommit(items, [1])).toBe(true);
  });

  it('未勾选条目不可提交；混合场景只保留已勾选且未阻塞者', () => {
    const items = [ok(0), ok(1), blocked(2)];
    expect(committableConfirmedIndexes(items, [1])).toEqual([1]);
    expect(committableConfirmedIndexes(items, [])).toEqual([]);
    expect(canCommit(items, [])).toBe(false);
  });
});

describe('commitGate — 批量采集默认勾选规则 (§四)', () => {
  const batch = (index: number, status: string, commitBlocked: boolean): CommitGateItem => ({
    index,
    extractionMetadata: { kind: 'boss_batch_capture', batchItemStatus: status, commitBlocked },
  });

  it('captured 默认勾选；needs_correction 不默认勾选；failed(blocked) 不默认勾选', () => {
    expect(shouldDefaultConfirm(batch(0, 'captured', false))).toBe(true);
    expect(shouldDefaultConfirm(batch(1, 'needs_correction', false))).toBe(false);
    expect(shouldDefaultConfirm(batch(2, 'failed', true))).toBe(false);
  });

  it('非批量项维持既有行为：未阻塞即默认勾选', () => {
    expect(shouldDefaultConfirm(ok(0))).toBe(true);
    expect(shouldDefaultConfirm(blocked(1))).toBe(false);
  });

  it('needs_correction 仍可提交（非阻塞），只是不默认勾选', () => {
    const items = [batch(0, 'needs_correction', false)];
    expect(committableConfirmedIndexes(items, [0])).toEqual([0]);
    expect(canCommit(items, [0])).toBe(true);
  });

  it('batchItemStatus 读取', () => {
    expect(batchItemStatus(batch(0, 'captured', false))).toBe('captured');
    expect(batchItemStatus(ok(1))).toBeNull();
  });
});
