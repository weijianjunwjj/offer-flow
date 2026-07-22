/** V8-2 采集桥的最小 URL 规范化：小写 host、去除默认端口、去除 fragment，保留 path/query。 */
export function normalizeSourceUrl(rawUrl: string | null): string | null {
  if (rawUrl === null) return null;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol === 'http:' && parsed.port === '80')
      || (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

export function extractSourceDomain(rawUrl: string | null): string | null {
  if (rawUrl === null) return null;
  try {
    return new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}
