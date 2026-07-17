const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function formatDateTime(
  timestamp: number | null | undefined,
  emptyLabel = '尚未记录',
): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return emptyLabel;
  return DATE_TIME_FORMATTER.format(new Date(timestamp));
}

export function formatOptionalText(
  value: string | null | undefined,
  emptyLabel = '暂无',
): string {
  const text = value?.trim() ?? '';
  return text === '' ? emptyLabel : text;
}

export const formatClosedState = (value: boolean) => value ? '已结束' : '未结束';
export const formatVoidedState = (value: boolean) => value ? '已作废' : '未作废';
