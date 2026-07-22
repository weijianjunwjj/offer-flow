import { BatchQueue, queueExpected, type BatchSummary, type QueueItem } from './batchQueue';
import type { KnownJobCapture, KnownJobExpected } from '../extractors/bossExtractor';

/**
 * V8-2 批量串行 Runner（可测试编排层，副作用经 RunnerEffects 注入）。
 *
 * 职责：驱动 BatchQueue 严格串行处理每一项 —— 按 externalRecordId 重定位卡片（队列不持久 DOM）→
 * 首项若右侧已匹配则免点击 → 否则原生点击并等右侧详情稳定 → 已知身份采集 → 映射单项状态。
 * 单项失败不影响后续项；支持 pause/resume/cancel（由 BatchQueue 状态驱动）。
 */

export interface RunnerEffects {
  /** 处理前按 externalRecordId 在当前 DOM 重新定位卡片；已移除返回 null。 */
  relocateCard(externalRecordId: string): Element | null;
  /** 当前右侧详情是否已经就是该岗位（用于首项免重复点击）。 */
  rightPanelMatchesExpected(externalRecordId: string): boolean;
  /** 原生点击卡片可点击节点（仅用于切换右侧详情）。 */
  clickCard(card: Element): void;
  /** 等右侧详情 fingerprint 改变并稳定；超时返回 timedOut=true（仍继续尝试采集，交由身份校验兜底）。 */
  waitForRightPanelStable(): Promise<{ timedOut: boolean }>;
  /** 对当前右侧详情执行已知身份采集。 */
  captureItem(expected: KnownJobExpected): KnownJobCapture;
  onProgress(snapshot: QueueItem[], summary: BatchSummary): void;
  sleep(ms: number): Promise<void>;
}

export interface RunnerOptions {
  /** 暂停轮询间隔。 */
  pollMs?: number;
  /** 每项之间的间隔（默认 800ms，建议 800–1500ms）。 */
  interItemMs?: number;
  /** 循环安全上限（防御无限循环）。 */
  maxIterations?: number;
}

export interface BatchItemResult {
  externalRecordId: string;
  selectionOrder: number;
  capture: KnownJobCapture;
}

const DEFAULTS: Required<RunnerOptions> = { pollMs: 200, interItemMs: 800, maxIterations: 10_000 };

export async function runBatch(
  queue: BatchQueue,
  effects: RunnerEffects,
  options: RunnerOptions = {},
): Promise<BatchItemResult[]> {
  const opts = { ...DEFAULTS, ...options };
  const results: BatchItemResult[] = [];
  let processedAny = false;
  queue.start();

  for (let iteration = 0; iteration < opts.maxIterations; iteration += 1) {
    if (queue.status === 'cancelled') break;
    if (queue.status === 'paused') {
      await effects.sleep(opts.pollMs);
      continue;
    }
    const next = queue.nextPending();
    if (next === null) {
      if (queue.allProcessed()) break;
      // 无待处理项但未全部完成（理论上不应发生，除非有 in-flight——串行下不会）：轮询等待。
      await effects.sleep(opts.pollMs);
      continue;
    }

    queue.beginItem(next.queueItemId); // navigating（同时保证串行：已有 in-flight 会抛错）
    const isFirst = !processedAny;
    processedAny = true;

    const card = effects.relocateCard(next.externalRecordId);
    if (card === null) {
      queue.setItemStatus(next.queueItemId, 'failed', { qualityIssues: ['卡片已从当前列表移除，无法重新定位到该岗位'] });
      effects.onProgress(queue.snapshot(), queue.summary());
      continue;
    }

    const alreadyMatched = isFirst && effects.rightPanelMatchesExpected(next.externalRecordId);
    if (!alreadyMatched) {
      effects.clickCard(card);
      queue.setItemStatus(next.queueItemId, 'observing');
      await effects.waitForRightPanelStable();
    }

    queue.setItemStatus(next.queueItemId, 'extracting');
    const capture = effects.captureItem(queueExpected(next));

    queue.setItemStatus(next.queueItemId, 'verifying');
    const issues = capture.blockingIssues.length > 0
      ? capture.blockingIssues
      : (capture.status === 'needs_correction' ? ['字段需人工确认后写入'] : []);
    queue.setItemStatus(next.queueItemId, capture.status, { qualityIssues: issues });

    results.push({ externalRecordId: next.externalRecordId, selectionOrder: next.selectionOrder, capture });
    effects.onProgress(queue.snapshot(), queue.summary());

    if (queue.nextPending() !== null) await effects.sleep(opts.interItemMs);
  }

  queue.finishIfDone();
  return results;
}
