import { describe, expect, it } from 'vitest';
import { BatchQueue, queueExpected } from './batchQueue';
import type { KnownJobExpected } from '../extractors/bossExtractor';

function expected(id: string, order: number): KnownJobExpected {
  return {
    externalRecordId: id,
    providerKey: 'boss_zhipin',
    canonicalSourceUrl: `https://www.zhipin.com/job_detail/${id}.html`,
    roleFromCard: `role-${order}`,
    salaryFromCardNorm: '11-13K',
    salaryFromCard: { minK: 11, maxK: 13, period: 'month' },
    salaryDecodedFromPua: true,
    companyDisplayName: '易诚互动',
    experienceFromCard: '3-5年',
    educationFromCard: '本科',
  };
}

function makeQueue(n: number): BatchQueue {
  return new BatchQueue(Array.from({ length: n }, (_, i) => expected(`ID${i}`, i)));
}

describe('BatchQueue — 串行状态机 (§八.10/§八.17/§八.18)', () => {
  it('严格串行：有 in-flight 项时 nextPending 返回 null，不允许并发 begin', () => {
    const q = makeQueue(3);
    q.start();
    const first = q.nextPending()!;
    q.beginItem(first.queueItemId);
    expect(q.hasActive()).toBe(true);
    expect(q.nextPending()).toBeNull();
    expect(() => q.beginItem('item-1')).toThrow(); // 已有 in-flight，禁止并发
  });

  it('按 selectionOrder 顺序处理', () => {
    const q = makeQueue(3);
    q.start();
    const order: number[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const next = q.nextPending();
      if (next === null) break;
      order.push(next.selectionOrder);
      q.beginItem(next.queueItemId);
      q.setItemStatus(next.queueItemId, 'captured');
    }
    expect(order).toEqual([0, 1, 2]);
  });

  it('单项失败不影响后续项，最终 done 且计数正确 (§八.17)', () => {
    const q = makeQueue(3);
    q.start();
    const outcomes = ['captured', 'failed', 'needs_correction'] as const;
    for (let i = 0; i < 3; i += 1) {
      const next = q.nextPending()!;
      q.beginItem(next.queueItemId);
      q.setItemStatus(next.queueItemId, outcomes[next.selectionOrder]!);
    }
    q.finishIfDone();
    expect(q.status).toBe('done');
    const s = q.summary();
    expect(s).toMatchObject({ selectedCount: 3, capturedCount: 1, failedCount: 1, needsCorrectionCount: 1, pendingCount: 0 });
  });

  it('暂停/继续/取消 (§八.18)', () => {
    const q = makeQueue(2);
    q.start();
    q.pause();
    expect(q.status).toBe('paused');
    expect(q.nextPending()).toBeNull(); // 暂停时不派发
    q.resume();
    expect(q.status).toBe('running');
    expect(q.nextPending()).not.toBeNull();
    q.cancel();
    expect(q.status).toBe('cancelled');
    expect(q.nextPending()).toBeNull();
    q.finishIfDone();
    expect(q.status).toBe('cancelled'); // 取消后不转 done
  });

  it('queueExpected 从队列项还原 KnownJobExpected（供 Runner 重定位与采集）', () => {
    const q = makeQueue(1);
    const item = q.snapshot()[0]!;
    const exp = queueExpected(item);
    expect(exp.externalRecordId).toBe('ID0');
    expect(exp.companyDisplayName).toBe('易诚互动');
    expect(exp.salaryFromCard).toEqual({ minK: 11, maxK: 13, period: 'month' });
    expect(exp.salaryDecodedFromPua).toBe(true);
  });

  it('beginItem 递增 attempts；snapshot 不共享引用', () => {
    const q = makeQueue(1);
    q.start();
    const id = q.nextPending()!.queueItemId;
    q.beginItem(id);
    expect(q.snapshot()[0]!.attempts).toBe(1);
    q.setItemStatus(id, 'retryable_failed');
    // 重试：resume 语义下 retryable_failed 不是 queued，不会被 nextPending 自动取（Runner 显式重排）
    expect(q.nextPending()).toBeNull();
  });
});
