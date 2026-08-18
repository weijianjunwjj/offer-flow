/**
 * v0.9 P0 — Cross-source Public Evidence Enrichment（identity-safe，纯函数 + 窄 DTO）。
 *
 * 目标：已知招聘平台（zhipin/liepin/zhaopin/lagou/51job）详情页禁止自动 fetch，
 * 但不能直接成为 pipeline dead-end。对每个招聘平台 discovery item，在**能证明
 * 公开替代源与原始 item 是同一公司 + 同一岗位**的前提下，做一次 bounded public 查询。
 *
 * identity-safe 硬边界（P0 正确性优先于召回）：
 *   - 必须有结构化 company identity（item.company 非空）才允许 enrichment；
 *     缺 company → fail closed（跳过 enrichment，保持 MANUAL_REVIEW_REQUIRED）。
 *   - 禁止 role-only 查询（"<role> 招聘" / "<role> careers"）为原 Candidate 做证据升级。
 *   - public alternative 必须非招聘平台、非原 URL、company 与原 item 一致、role/title 合理匹配，
 *     才允许进入 SourcePolicy → ContentFetcher → Validation → EvidenceUpgrade。
 *   - 本模块只产出查询与候选过滤，不触发真实网络（search 由调用方注入）。
 *   - 禁止 enrichment → enrichment 递归（候选过滤按 fetchEligible 只保留 SEARCH_AND_FETCH，
 *     且调用方用 seenUrls 去重）。
 *   - 禁止引入 LLM 猜测公司身份；禁止模糊匹配不同公司（匹配是精确子串，非相似度）。
 */

import type { SearchEvidenceItem, SearchQuery } from '../search-provider/types';
import { getSourcePolicyDecision, isRecruitmentPlatform } from '../radar/sourcePolicy/sourcePolicy';

/** 判断一个 ingestion item 是否来自已知招聘平台（需要触发 cross-source enrichment）。 */
export function isRecruitmentSource(normalizedDomain: string): boolean {
  return normalizedDomain !== '' && isRecruitmentPlatform(normalizedDomain);
}

/** 供查询构造与候选匹配共用的最小身份（公司 + 岗位）。 */
export interface CrossSourceIdentity {
  /** 结构化公司身份（原始 trim，未小写）。 */
  company: string;
  /** 岗位/角色（来自 title，原始 trim）。 */
  role: string;
}

/**
 * 从一条 Search Evidence 提取 identity-safe 所需的最小身份。
 *
 * 关键约束：company 必须来自**结构化字段** `item.company`（当前 Tavily 不提供 → 恒 null）。
 * 不做 title/snippet 的公司猜测（bracket 前缀、snippet 切词均不可靠，可能误判公司/标签/城市）。
 * company 或 role 缺失 → 返回 null（fail closed，不做 enrichment）。
 */
export function extractCrossSourceIdentity(item: SearchEvidenceItem): CrossSourceIdentity | null {
  const company = (item.company ?? '').trim();
  const role = (item.title ?? '').trim();
  if (company === '' || role === '') return null;
  return { company, role };
}

/**
 * 由一条招聘平台 Search Evidence 构造 public alternative 查询（company + role）。
 *
 * 无结构化 company identity → 返回空数组（调用方跳过该 item 的 enrichment）。
 * 不产生任何 role-only 查询。
 */
export function buildCrossSourceQueries(item: SearchEvidenceItem): SearchQuery[] {
  const identity = extractCrossSourceIdentity(item);
  if (identity === null) return [];

  const query = `${identity.company} ${identity.role}`;
  return [{
    query,
    queryKey: `cross-source:${identity.company}:${identity.role}`,
    city: '',
    roleDirection: identity.role,
    keyword: '',
    keywordSource: 'base',
  }];
}

/** 精确子串匹配（不区分大小写）。 */
function contains(haystack: string, needle: string): boolean {
  return haystack.trim().toLowerCase().includes(needle.trim().toLowerCase());
}

/** company 身份匹配：结构化 company 优先；否则 title/url 精确子串命中（不查 snippet，避免噪声）。 */
function matchesCompany(candidate: SearchEvidenceItem, company: string): boolean {
  const structured = (candidate.company ?? '').trim();
  if (structured !== '') return contains(structured, company);
  return contains(candidate.title, company) || contains(candidate.url, company);
}

/** role/title 合理匹配：候选 title 含原 role，或原 role 含候选 title（精确子串，非相似度）。 */
function matchesRole(candidate: SearchEvidenceItem, role: string): boolean {
  const title = candidate.title.trim();
  if (title === '') return false;
  return contains(title, role) || contains(role, title);
}

/**
 * 过滤 enrichment 搜索结果为「可安全 fetch 的公开替代源」，四条都必须满足：
 *   1. fetchEligible（排除招聘平台 / 空域 / CONDITIONAL_FETCH）
 *   2. 非原 URL 且非候选间重复（seenUrls + local dedupe）
 *   3. company identity 与原 item 一致
 *   4. role/title 合理匹配
 */
export function filterCrossSourceCandidates(
  items: SearchEvidenceItem[],
  identity: CrossSourceIdentity,
  seenUrls: ReadonlySet<string>,
): SearchEvidenceItem[] {
  const local = new Set<string>();
  const result: SearchEvidenceItem[] = [];

  for (const item of items) {
    const url = item.url;
    if (url === '' || seenUrls.has(url) || local.has(url)) continue;

    const decision = getSourcePolicyDecision(url);
    if (!decision.fetchEligible) continue;

    if (!matchesCompany(item, identity.company)) continue;
    if (!matchesRole(item, identity.role)) continue;

    local.add(url);
    result.push(item);
  }

  return result;
}
