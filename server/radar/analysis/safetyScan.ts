/**
 * V8-4 分析契约的递归安全扫描。
 *
 * 两类独立扫描，二者都**与 Zod 并行**（Zod 保结构，扫描保内容/泄漏），互不替代：
 * - forbidden content：Cookie/Authorization/Bearer/Token/securityId、HTML 标签、
 *   本地绝对路径等敏感或不安全内容；
 * - internal id leak：键名或字符串中出现内部数据库 ID 字段/确定性 ID 前缀。
 *
 * 扫描对**键名与字符串值**递归下钻，不依赖单一 `String.includes` 判定。
 */

/** HTML 标签样式：<div>、</p>、<a href=...>、<br/> 等。 */
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?>/i;

/** 本地绝对路径：Windows 盘符或常见 POSIX 根目录。 */
const ABSOLUTE_PATH = /(^|[\s"'(=])([a-z]:\\|\/(?:users|home|var|etc|tmp|root|opt|usr)\/)/i;

/** 敏感内容模式（凭证/令牌/会话标识）。命中即判定不安全。 */
const FORBIDDEN_CONTENT: RegExp[] = [
  /\bcookie\b/i,
  /set-cookie/i,
  /authorization\s*[:=]/i,
  /\bbearer\s+[a-z0-9._-]+/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /\bsecurityid\b/i,
  /\bsessionid\b/i,
  HTML_TAG,
  ABSOLUTE_PATH,
];

/**
 * 内部数据库 ID 键名：candidateId / candidateVersionId / resumeVersionId /
 * profileVersionId / assessmentId / sourceSnapshotId / taskId / recordId / sessionId 等。
 * 通过「语义前缀 + Id/VersionId 后缀」匹配，避免误伤 evidenceKeys 等业务键。
 */
const INTERNAL_ID_KEY =
  /^(candidate|resume|profile|jobMatchProfile|capabilityBaseline|marketPosition|strategy|assessment|rule|source|snapshot|task|record|analysis|session|action|promotion|relation)([A-Z][a-zA-Z]*)?(Id|VersionId)$/;

/** 确定性 ID 前缀（快照/任务 ID 明文不得进入 LLM 输入或 Payload）。 */
const INTERNAL_ID_VALUE: RegExp[] = [
  /\banalysis-task:v\d+:/i,
  /\bjob-match-analysis-input:v\d+:/i,
];

export interface ScanHit {
  path: string;
  reason: string;
}

function walk(
  value: unknown,
  path: string,
  onString: (text: string, path: string) => ScanHit | null,
  onKey: ((key: string, path: string) => ScanHit | null) | null,
  hits: ScanHit[],
): void {
  if (typeof value === 'string') {
    const hit = onString(value, path);
    if (hit !== null) hits.push(hit);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, onString, onKey, hits));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (onKey !== null) {
        const keyHit = onKey(key, `${path}.${key}`);
        if (keyHit !== null) hits.push(keyHit);
      }
      walk(nested, `${path}.${key}`, onString, onKey, hits);
    }
  }
}

/** 扫描敏感/不安全内容（Cookie/Token/HTML/绝对路径等）。返回全部命中。 */
export function scanForbiddenContent(value: unknown, rootPath = '$'): ScanHit[] {
  const hits: ScanHit[] = [];
  walk(
    value,
    rootPath,
    (text, path) => {
      const matched = FORBIDDEN_CONTENT.find((re) => re.test(text));
      return matched === undefined ? null : { path, reason: `匹配禁止内容模式 ${matched.source}` };
    },
    null,
    hits,
  );
  return hits;
}

/** 单独扫描 HTML 标签（供 Payload 精确映射 ANALYSIS_HTML_NOT_ALLOWED）。 */
export function scanHtml(value: unknown, rootPath = '$'): ScanHit[] {
  const hits: ScanHit[] = [];
  walk(
    value,
    rootPath,
    (text, path) => (HTML_TAG.test(text) ? { path, reason: '包含 HTML 标签' } : null),
    null,
    hits,
  );
  return hits;
}

/** 扫描内部数据库 ID 泄漏（键名 + 确定性 ID 前缀值）。返回全部命中。 */
export function scanInternalIdLeak(value: unknown, rootPath = '$'): ScanHit[] {
  const hits: ScanHit[] = [];
  walk(
    value,
    rootPath,
    (text, path) => {
      const matched = INTERNAL_ID_VALUE.find((re) => re.test(text));
      return matched === undefined ? null : { path, reason: `值包含内部 ID 前缀 ${matched.source}` };
    },
    (key, path) => (INTERNAL_ID_KEY.test(key) ? { path, reason: `键名疑似内部数据库 ID：${key}` } : null),
    hits,
  );
  return hits;
}
