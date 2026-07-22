/**
 * 采集预览「确认写入」闸门（§九）：纯函数，供 RadarImportPage 与单测共用。
 *
 * 规则：list_panel 未能唯一绑定当前岗位、或未定位到右侧详情等情况会被抽取层标记
 * commitBlocked=true。被阻塞条目：
 * - 不得自动勾选、不得纳入确认；
 * - 即使因任何原因被勾选，也必须在提交前过滤掉（前端防御，不只依赖后端拒绝）；
 * - 当全部条目都被阻塞或未勾选时，全局「确认写入」按钮禁用且不发起 commit 请求。
 */

/** 预览条目的最小结构（只依赖 gating 需要的字段，便于单测）。 */
export interface CommitGateItem {
  index: number;
  extractionMetadata?: Record<string, unknown> | null;
}

export function isItemCommitBlocked(item: CommitGateItem): boolean {
  const meta = item.extractionMetadata;
  return meta !== null && meta !== undefined && (meta as { commitBlocked?: unknown }).commitBlocked === true;
}

export function itemBlockingIssues(item: CommitGateItem): string[] {
  const meta = item.extractionMetadata;
  const issues = meta !== null && meta !== undefined ? (meta as { blockingIssues?: unknown }).blockingIssues : undefined;
  return Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === 'string') : [];
}

/** 批量采集项状态（captured/needs_correction/failed）；非批量项返回 null。 */
export function batchItemStatus(item: CommitGateItem): string | null {
  const meta = item.extractionMetadata;
  const status = meta !== null && meta !== undefined ? (meta as { batchItemStatus?: unknown }).batchItemStatus : undefined;
  return typeof status === 'string' ? status : null;
}

/**
 * 加载时是否默认勾选：阻塞项永不默认勾选；批量项仅 captured 默认勾选（needs_correction 需人工确认后再勾）；
 * 非批量项维持既有行为（未阻塞即默认勾选）。
 */
export function shouldDefaultConfirm(item: CommitGateItem): boolean {
  if (isItemCommitBlocked(item)) return false;
  const status = batchItemStatus(item);
  if (status !== null) return status === 'captured';
  return true;
}

/**
 * 计算最终可提交的条目索引：已勾选且未被阻塞。阻塞条目即使被勾选也一律剔除，升序去重返回。
 */
export function committableConfirmedIndexes(
  items: CommitGateItem[],
  confirmedIndexes: Iterable<number>,
): number[] {
  const confirmed = new Set<number>(confirmedIndexes);
  const blockedByIndex = new Map<number, boolean>();
  for (const item of items) blockedByIndex.set(item.index, isItemCommitBlocked(item));
  const result = new Set<number>();
  for (const index of confirmed) {
    // 未知 index（不在当前条目里）视为不可提交，避免越界索引进入 commit。
    if (blockedByIndex.get(index) === false) result.add(index);
  }
  return [...result].sort((a, b) => a - b);
}

/** 是否存在任何可提交条目（决定全局「确认写入」按钮是否可用）。 */
export function canCommit(items: CommitGateItem[], confirmedIndexes: Iterable<number>): boolean {
  return committableConfirmedIndexes(items, confirmedIndexes).length > 0;
}
