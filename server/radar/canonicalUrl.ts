/**
 * V8-3 provider-aware canonical source URL（用于 Tier-2 exact identity）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §4/§15。
 *
 * 严格边界：
 * - 移除全部动态 query（securityId/token/时间戳等），只保留稳定的岗位身份路径；
 * - 只有确认是"岗位详情身份 URL"才返回可用于身份的 canonical；
 * - 搜索页、推荐页、列表页 URL 一律不参与 exact identity（返回 usableForIdentity=false）；
 * - 不猜测：无法确认 provider 详情形态时保守返回 usableForIdentity=false。
 */

export interface CanonicalUrlResult {
  /** 规范化后的 URL 字符串（用于展示/存储），无法解析时为 null。 */
  canonicalUrl: string | null;
  /** 是否可作为 Tier-2 稳定身份键。仅岗位详情身份 URL 为 true。 */
  usableForIdentity: boolean;
  /** provider 键（如 boss），无法识别为 null。 */
  providerKey: string | null;
  /** 不可用于身份时的原因，便于诊断（不含敏感 query）。 */
  reason: string | null;
}

interface ProviderRule {
  providerKey: string;
  hostSuffixes: string[];
  /** 判定给定 pathname 是否为岗位详情身份路径，返回稳定身份路径或 null。 */
  detailIdentityPath(pathname: string): string | null;
}

const BOSS_RULE: ProviderRule = {
  providerKey: 'boss',
  hostSuffixes: ['zhipin.com'],
  detailIdentityPath(pathname) {
    // BOSS 岗位详情：/job_detail/<id>.html 或 /job_detail/<id>
    const m = pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)(?:\.html)?$/);
    if (m) return `/job_detail/${m[1]}`;
    return null;
  },
};

const PROVIDER_RULES: ProviderRule[] = [BOSS_RULE];

/** 已知的搜索/推荐/列表路径前缀（这些永不作为 exact identity）。 */
const NON_DETAIL_HINTS = ['/web/geek/jobs', '/job_recommend', '/search', '/c'];

function hostMatches(host: string, suffixes: string[]): boolean {
  const lower = host.toLowerCase();
  return suffixes.some((s) => lower === s || lower.endsWith(`.${s}`));
}

/**
 * 计算 canonical URL 与身份可用性。
 * 只移除动态 query（不保留任何 query），保留 host + 规范化后的详情路径。
 */
export function canonicalizeSourceUrl(rawUrl: string | null): CanonicalUrlResult {
  if (rawUrl === null) {
    return { canonicalUrl: null, usableForIdentity: false, providerKey: null, reason: 'null url' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return { canonicalUrl: null, usableForIdentity: false, providerKey: null, reason: 'empty url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { canonicalUrl: null, usableForIdentity: false, providerKey: null, reason: 'unparsable url' };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const rule = PROVIDER_RULES.find((r) => hostMatches(host, r.hostSuffixes)) ?? null;

  // 无论 provider 是否已知，展示用 canonical 一律去 query/fragment、小写 host、去默认端口。
  let displayCanonical = `${parsed.protocol}//${host}`;
  if (
    parsed.port !== ''
    && !((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443'))
  ) {
    displayCanonical += `:${parsed.port}`;
  }
  displayCanonical += pathname;

  if (rule === null) {
    return { canonicalUrl: displayCanonical, usableForIdentity: false, providerKey: null, reason: 'unknown provider host' };
  }

  // 明确的非详情页（搜索/推荐/列表）—— 不参与 exact identity。
  if (NON_DETAIL_HINTS.some((hint) => pathname === hint || pathname.startsWith(`${hint}/`))) {
    return { canonicalUrl: displayCanonical, usableForIdentity: false, providerKey: rule.providerKey, reason: 'non-detail page url' };
  }

  const identityPath = rule.detailIdentityPath(pathname);
  if (identityPath === null) {
    return { canonicalUrl: displayCanonical, usableForIdentity: false, providerKey: rule.providerKey, reason: 'not a job-detail identity url' };
  }

  const identityCanonical = `${parsed.protocol}//${host}${identityPath}`;
  return { canonicalUrl: identityCanonical, usableForIdentity: true, providerKey: rule.providerKey, reason: null };
}
