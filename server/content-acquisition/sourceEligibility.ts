/**
 * v0.9 Phase 4C-1 — Source Eligibility 纯函数（复用既有 Source Policy，无第二套黑名单）。
 *
 * 设计依据：specs/001-daily-job-hunter/tasks.md T035。
 *
 * 本模块只派生「是否允许进入 Content Acquisition」，唯一事实源是
 * getSourcePolicyDecision() 的 fetchEligible 判定：
 *   SEARCH_AND_FETCH → eligible
 *   SEARCH_ONLY / CONDITIONAL_FETCH / unknown → ineligible（保守拒绝）
 *
 * 招聘平台（zhipin / liepin / zhaopin / lagou / 51job）已经在 Source Policy 层
 * 被判为 SEARCH_ONLY，本模块不复制该域名清单。
 */

import { getSourcePolicyDecision } from '../radar/sourcePolicy/sourcePolicy';
import type { ContentFetchError } from './errors';
import type { ContentFetchRequest } from './types';

export type SourceEligibilityResult =
  | { kind: 'eligible'; request: ContentFetchRequest }
  | { kind: 'ineligible'; error: ContentFetchError };

/**
 * 依据 Source Policy 判断给定 URL 是否允许自动 Content Acquisition。
 * eligible 时返回一个 sourcePolicy 已窄化为 'SEARCH_AND_FETCH' 的受限请求；
 * 被禁止的来源只返回 ineligible，无法通过本函数拿到可 fetch 的请求。
 */
export function sourceEligibility(url: string): SourceEligibilityResult {
  const decision = getSourcePolicyDecision(url);

  if (decision.fetchEligible) {
    return {
      kind: 'eligible',
      request: {
        url,
        normalizedDomain: decision.normalizedDomain,
        sourcePolicy: 'SEARCH_AND_FETCH',
      },
    };
  }

  return {
    kind: 'ineligible',
    error: {
      code: 'BLOCKED_BY_POLICY',
      reason: decision.reason,
    },
  };
}
