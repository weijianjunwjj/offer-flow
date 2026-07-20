/** 雷达领域存储层损坏错误：JSON 列无法解析或缺失必需字段。 */
export class RadarStorageCorruptionError extends Error {
  readonly storageCause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RadarStorageCorruptionError';
    this.storageCause = cause;
  }
}

export function parseJsonColumn(column: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new RadarStorageCorruptionError(`存储列 ${column} 不是 JSON 字符串`);
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new RadarStorageCorruptionError(`存储列 ${column} 包含非法 JSON`, error);
  }
}
