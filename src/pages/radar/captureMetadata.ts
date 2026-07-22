/**
 * 从自由形式 extractionMetadata 安全读取招聘者“采集时活跃状态”。
 * 兼容顶层快照值与 fields provenance；拒绝超长/非字符串数据，绝不读取其它招聘者字段。
 */
export function readCapturedActivityStatus(metadata: Record<string, unknown> | null | undefined): string | null {
  if (metadata === null || metadata === undefined) return null;
  const direct = metadata.activityStatus;
  if (typeof direct === 'string' && direct.trim().length > 0 && direct.trim().length <= 30) {
    return direct.trim();
  }
  const fields = metadata.fields;
  if (fields === null || typeof fields !== 'object') return null;
  const activity = (fields as Record<string, unknown>).activityStatus;
  if (activity === null || typeof activity !== 'object') return null;
  const value = (activity as Record<string, unknown>).value;
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 30
    ? value.trim()
    : null;
}
