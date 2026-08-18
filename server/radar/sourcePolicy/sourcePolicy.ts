/**
 * v0.9 Phase 4A — Source Policy + Evidence Level Mapping（纯函数，无 DB / 无副作用）。
 *
 * 设计依据：
 *   specs/001-daily-job-hunter/plan.md v3.0 §2.9
 *   specs/001-daily-job-hunter/tasks.md T033 / T034
 *
 * 核心约束：
 *   - SourcePolicy 表示来源允许的处理策略（允许做什么）；
 *   - EvidenceLevel 表示当前这条数据实际已有的证据等级；
 *   - 本轮不实现 Content Acquisition → 任何 Source Policy 的 initialEvidenceLevel
 *     都不能是 FULL_EVIDENCE；
 *   - FULL_EVIDENCE 只能由外部显式传入（Content Acquisition 成功并通过 JD 完整性验证
 *     后的 evidence_upgrade，或 Manual Capture 升级后）；fetch 成功本身不等于 FULL_EVIDENCE。
 *
 * getSourcePolicyDecision 返回完整的判定结果：
 *   - policy: 来源允许的策略
 *   - initialEvidenceLevel: 搜索结果当前实际的证据等级（永远不是 FULL_EVIDENCE）
 *   - fetchEligible: 本轮是否允许自动 fetch
 *   - targetEvidenceLevelAfterFetch: Content Acquisition 成功 **且** 通过 JD 完整性验证 /
 *     evidence_upgrade 后可达到的等级（不代表 fetch 成功即自动写入 FULL_EVIDENCE）
 *   - reason: 判定理由（区分已知来源 / 未知来源）
 *   - normalizedDomain: 规范化后的域名，供 audit / SourceRun / 日志追踪
 */

import type { RadarEvidenceLevel } from '../../../src/domain/radar';

// ── Types ──────────────────────────────────────────────────────────────────────

export type SourcePolicy = 'SEARCH_ONLY' | 'SEARCH_AND_FETCH' | 'CONDITIONAL_FETCH';

export interface SourcePolicyDecision {
  policy: SourcePolicy;
  initialEvidenceLevel: RadarEvidenceLevel;
  fetchEligible: boolean;
  targetEvidenceLevelAfterFetch: RadarEvidenceLevel | null;
  reason: string;
  normalizedDomain: string;
}

// ── Domain classification — recruitment platforms (SEARCH_ONLY) ────────────────

/**
 * 专业招聘平台——禁止自动 Fetch，仅允许保存 Search Evidence + 人工确认。
 * 匹配基于二级域名（例如 zhipin.com / www.zhipin.com / *.zhipin.com）。
 */
const RECRUITMENT_PLATFORM_SUFFIXES = [
  'zhipin.com',
  'liepin.com',
  'zhaopin.com',
  'lagou.com',
  '51job.com',
] as const;

/** 判断 domain 是否匹配 recruitment platform suffix（包括任意子域名）。 */
export function isRecruitmentPlatform(normalized: string): boolean {
  return RECRUITMENT_PLATFORM_SUFFIXES.some((suffix) => {
    return normalized === suffix || normalized.endsWith('.' + suffix);
  });
}

// ── Domain classification — SEARCH_AND_FETCH (fetch eligible) ──────────────────

/**
 * SEARCH_AND_FETCH 来源：
 *   - *.zhiye.com（ATS 平台，如 jobs.zhiye.com / hr.zhiye.com）
 *   - github.com / gist.github.com
 */
const SEARCH_AND_FETCH_SUFFIXES = [
  'zhiye.com',
] as const;

const SEARCH_AND_FETCH_EXACT = [
  'github.com',
  'gist.github.com',
] as const;

function isSearchAndFetchDomain(normalized: string): boolean {
  if (SEARCH_AND_FETCH_EXACT.some((exact) => normalized === exact)) return true;
  return SEARCH_AND_FETCH_SUFFIXES.some((suffix) => {
    return normalized.endsWith('.' + suffix) || normalized === suffix;
  });
}

// ── Domain classification — CONDITIONAL_FETCH ──────────────────────────────────

const CONDITIONAL_FETCH_DOMAINS = [
  'juejin.cn',
] as const;

// ── Reason constants (differentiated per user feedback) ────────────────────────

const REASON_KNOWN_RECRUITMENT = 'known_recruitment_platform_manual_review_required';
const REASON_SEARCH_AND_FETCH = 'search_and_fetch_allowed_upgrade_to_full_evidence';
const REASON_CONDITIONAL_DEFAULT = 'conditional_fetch_default_no_fetch';
const REASON_UNKNOWN_PUBLIC_FETCH_ELIGIBLE = 'unknown_public_fetch_eligible';
const REASON_EMPTY_DOMAIN = 'empty_domain_manual_review_required';

// ── Normalization ──────────────────────────────────────────────────────────────

/**
 * 规范化域名：去除协议、路径、端口、前后空白；转小写。
 * 对无效输入（空串 / null / undefined）返回 ''。
 */
export function normalizeDomain(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw.trim() === '') return '';
  let domain = raw.trim().toLowerCase();
  // 移除 protocol
  if (domain.startsWith('https://')) domain = domain.slice(8);
  else if (domain.startsWith('http://')) domain = domain.slice(7);
  // 移除 path / query / hash
  const slash = domain.indexOf('/');
  if (slash !== -1) domain = domain.slice(0, slash);
  // 移除 port
  const colon = domain.lastIndexOf(':');
  if (colon !== -1) domain = domain.slice(0, colon);
  // 移除前后空白（再 trim 一次）
  domain = domain.trim();
  return domain;
}

// ── classifySourcePolicy ───────────────────────────────────────────────────────

/**
 * 根据域名返回 SourcePolicy。
 *
 *   招聘平台（zhipin/liepin/zhaopin/lagou/51job）→ SEARCH_ONLY
 *   空/无效域名 → SEARCH_ONLY（无可 fetch 的 URL）
 *   ATS / company careers / GitHub（*.zhiye.com / github.com）→ SEARCH_AND_FETCH
 *   juejin.cn → CONDITIONAL_FETCH
 *   其他 unknown public domain → SEARCH_AND_FETCH（受控自动 fetch，仍走 SSRF/redirect/validation 安全检查）
 */
export function classifySourcePolicy(domain: string): SourcePolicy {
  const normalized = normalizeDomain(domain);
  if (normalized === '') return 'SEARCH_ONLY';

  // Recruitment platforms (SEARCH_ONLY) — highest priority
  if (isRecruitmentPlatform(normalized)) return 'SEARCH_ONLY';

  // SEARCH_AND_FETCH domains（显式白名单）
  if (isSearchAndFetchDomain(normalized)) return 'SEARCH_AND_FETCH';

  // CONDITIONAL_FETCH domains
  if (CONDITIONAL_FETCH_DOMAINS.some((d) => normalized === d || normalized.endsWith('.' + d))) {
    return 'CONDITIONAL_FETCH';
  }

  // 普通 unknown public domain → 受控自动 fetch（ContentFetcher 内部仍有 SSRF/redirect/校验兜底）
  return 'SEARCH_AND_FETCH';
}

// ── getSourcePolicyDecision ────────────────────────────────────────────────────

/**
 * 返回完整的 SourcePolicyDecision：
 *   - 策略 → 初始证据等级 → 是否允许 fetch → fetch 后的目标等级 → 理由 → 规范化域名
 *
 * 核心语义：
 *   - SEARCH_ONLY → MANUAL_REVIEW_REQUIRED，禁止 fetch（招聘平台 / 空无效域名）
 *   - SEARCH_AND_FETCH → SEARCH_EVIDENCE，允许 fetch，目标 FULL_EVIDENCE（显式白名单或 unknown public）
 *   - CONDITIONAL_FETCH → SEARCH_EVIDENCE，默认不 fetch，fetch 后目标 FULL_EVIDENCE
 *
 * 无论什么 policy，initialEvidenceLevel 永远不是 FULL_EVIDENCE。
 */
export function getSourcePolicyDecision(domain: string): SourcePolicyDecision {
  const normalizedDomain = normalizeDomain(domain);
  const policy = classifySourcePolicy(domain);

  switch (policy) {
    case 'SEARCH_ONLY': {
      // 区分 reason：已知招聘平台 vs 空/无效域名（两者都禁止 fetch）
      const reason = normalizedDomain !== '' && isRecruitmentPlatform(normalizedDomain)
        ? REASON_KNOWN_RECRUITMENT
        : REASON_EMPTY_DOMAIN;
      return {
        policy,
        initialEvidenceLevel: 'MANUAL_REVIEW_REQUIRED',
        fetchEligible: false,
        targetEvidenceLevelAfterFetch: null,
        reason,
        normalizedDomain,
      };
    }

    case 'SEARCH_AND_FETCH': {
      // 区分 reason：显式白名单 vs 普通 unknown public domain（都为受控 fetch）
      const reason = isSearchAndFetchDomain(normalizedDomain)
        ? REASON_SEARCH_AND_FETCH
        : REASON_UNKNOWN_PUBLIC_FETCH_ELIGIBLE;
      return {
        policy,
        initialEvidenceLevel: 'SEARCH_EVIDENCE',
        fetchEligible: true,
        targetEvidenceLevelAfterFetch: 'FULL_EVIDENCE',
        reason,
        normalizedDomain,
      };
    }

    case 'CONDITIONAL_FETCH': {
      return {
        policy,
        initialEvidenceLevel: 'SEARCH_EVIDENCE',
        fetchEligible: false,
        targetEvidenceLevelAfterFetch: null,
        reason: REASON_CONDITIONAL_DEFAULT,
        normalizedDomain,
      };
    }
  }
}
