import type { KnownJobExpected } from '../extractors/bossExtractor';

/**
 * V8-2 批量采集队列状态机（纯逻辑，无 DOM / 无 timer / 无网络）。
 *
 * - 队列项只保存稳定数据快照，**不持有 HTMLElement/Node**（处理前由 Runner 按 externalRecordId 重定位）；
 * - 严格串行：同一时刻至多一个 in-flight 项（navigating/observing/extracting/verifying）；
 * - 支持 pause / resume / cancel；单项失败不影响后续项。
 */

export type QueueItemStatus =
  | 'queued'
  | 'navigating'
  | 'observing'
  | 'extracting'
  | 'verifying'
  | 'captured'
  | 'needs_correction'
  | 'failed'
  | 'retryable_failed';

export type BatchStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled';

const IN_FLIGHT: ReadonlySet<QueueItemStatus> = new Set<QueueItemStatus>([
  'navigating', 'observing', 'extracting', 'verifying',
]);
const TERMINAL: ReadonlySet<QueueItemStatus> = new Set<QueueItemStatus>([
  'captured', 'needs_correction', 'failed',
]);

export interface QueueItem {
  queueItemId: string;
  selectionOrder: number;
  providerKey: string;
  externalRecordId: string;
  canonicalSourceUrl: string;
  roleFromCard: string | null;
  companyDisplayName: string | null;
  salaryFromCardNorm: string | null;
  salaryFromCard: { minK: number | null; maxK: number | null; period: string | null } | null;
  salaryDecodedFromPua: boolean;
  experienceFromCard: string | null;
  educationFromCard: string | null;
  status: QueueItemStatus;
  attempts: number;
  qualityIssues: string[];
}

export interface BatchSummary {
  selectedCount: number;
  capturedCount: number;
  needsCorrectionCount: number;
  failedCount: number;
  pendingCount: number;
}

export function queueExpected(item: QueueItem): KnownJobExpected {
  return {
    externalRecordId: item.externalRecordId,
    providerKey: item.providerKey,
    canonicalSourceUrl: item.canonicalSourceUrl,
    roleFromCard: item.roleFromCard,
    salaryFromCardNorm: item.salaryFromCardNorm,
    salaryFromCard: item.salaryFromCard,
    salaryDecodedFromPua: item.salaryDecodedFromPua,
    companyDisplayName: item.companyDisplayName,
    experienceFromCard: item.experienceFromCard,
    educationFromCard: item.educationFromCard,
  };
}

export class BatchQueue {
  private items: QueueItem[];
  private batchStatus: BatchStatus = 'idle';

  constructor(expectedList: KnownJobExpected[]) {
    this.items = expectedList.map((expected, index) => ({
      queueItemId: `item-${index}`,
      selectionOrder: index,
      providerKey: expected.providerKey,
      externalRecordId: expected.externalRecordId,
      canonicalSourceUrl: expected.canonicalSourceUrl,
      roleFromCard: expected.roleFromCard,
      companyDisplayName: expected.companyDisplayName,
      salaryFromCardNorm: expected.salaryFromCardNorm,
      salaryFromCard: expected.salaryFromCard,
      salaryDecodedFromPua: expected.salaryDecodedFromPua ?? false,
      experienceFromCard: expected.experienceFromCard,
      educationFromCard: expected.educationFromCard,
      status: 'queued',
      attempts: 0,
      qualityIssues: [],
    }));
  }

  get status(): BatchStatus {
    return this.batchStatus;
  }

  snapshot(): QueueItem[] {
    return this.items.map((item) => ({ ...item, qualityIssues: [...item.qualityIssues] }));
  }

  start(): void {
    if (this.batchStatus === 'idle' || this.batchStatus === 'paused') this.batchStatus = 'running';
  }

  pause(): void {
    if (this.batchStatus === 'running') this.batchStatus = 'paused';
  }

  resume(): void {
    if (this.batchStatus === 'paused') this.batchStatus = 'running';
  }

  cancel(): void {
    this.batchStatus = 'cancelled';
  }

  hasActive(): boolean {
    return this.items.some((item) => IN_FLIGHT.has(item.status));
  }

  /** 下一个待处理项：running、无 in-flight、且存在 queued 项时返回；否则 null。 */
  nextPending(): QueueItem | null {
    if (this.batchStatus !== 'running' || this.hasActive()) return null;
    return this.items.find((item) => item.status === 'queued') ?? null;
  }

  private find(id: string): QueueItem {
    const item = this.items.find((candidate) => candidate.queueItemId === id);
    if (item === undefined) throw new Error(`unknown queue item: ${id}`);
    return item;
  }

  /** 开始处理某项（进入 in-flight，attempts++）。要求 running 且当前无 in-flight，保证串行。 */
  beginItem(id: string): void {
    if (this.batchStatus !== 'running') throw new Error('batch not running');
    if (this.hasActive()) throw new Error('another item is already in flight (serial only)');
    const item = this.find(id);
    item.status = 'navigating';
    item.attempts += 1;
  }

  setItemStatus(id: string, status: QueueItemStatus, patch?: Partial<Pick<QueueItem, 'qualityIssues'>>): void {
    const item = this.find(id);
    item.status = status;
    if (patch?.qualityIssues !== undefined) item.qualityIssues = [...patch.qualityIssues];
  }

  /** 所有项均已终结（captured/needs_correction/failed）。 */
  allProcessed(): boolean {
    return this.items.every((item) => TERMINAL.has(item.status));
  }

  /** 全部处理完 → done（除非已 cancelled）。 */
  finishIfDone(): void {
    if (this.batchStatus === 'cancelled') return;
    if (this.allProcessed()) this.batchStatus = 'done';
  }

  summary(): BatchSummary {
    let captured = 0;
    let needsCorrection = 0;
    let failed = 0;
    let pending = 0;
    for (const item of this.items) {
      if (item.status === 'captured') captured += 1;
      else if (item.status === 'needs_correction') needsCorrection += 1;
      else if (item.status === 'failed') failed += 1;
      else pending += 1;
    }
    return {
      selectedCount: this.items.length,
      capturedCount: captured,
      needsCorrectionCount: needsCorrection,
      failedCount: failed,
      pendingCount: pending,
    };
  }
}
