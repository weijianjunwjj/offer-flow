/** 失败指纹：把失败日志归一化后取 sha256 前缀，用于识别「同一失败连续出现」。 */
import { createHash } from 'node:crypto';

/** 归一化：去掉行号、时间戳、临时路径、十六进制哈希等易变部分，避免同一根因被误判成不同失败。 */
export function normalizeFailureText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, '<timestamp>')
    .replace(/:\d+:\d+\)?/g, ':<line>:<col>)')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\/[^\s"']*\.cc-auto\/runs\/[^\s"']+/g, '<run-path>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function computeFailureFingerprint(raw: string): string {
  const normalized = normalizeFailureText(raw);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/** 日志裁剪：只保留前后若干行，避免把整段海量输出写入 run 状态文件。 */
export function truncateLog(raw: string, maxLines = 60): string {
  const lines = raw.split('\n');
  if (lines.length <= maxLines) return raw;
  const head = lines.slice(0, Math.ceil(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [...head, `... (${lines.length - maxLines} 行已省略) ...`, ...tail].join('\n');
}
