/**
 * v0.9 Phase 4C-1 — ContentFetcher 契约测试。
 *
 * 覆盖 Amendment 的结构 / 类型不变量与纯行为：
 *   - FETCHED + 证据不完整 ≠ FULL_EVIDENCE
 *   - FETCHED + 验证 PASS → evidenceUpgradeEligible（但不写 FULL_EVIDENCE）
 *   - 错误状态可区分
 *   - 公共契约不含 rawHtml / raw_content / evidenceLevel / success
 *
 * 结构不变量用编译期类型断言（vue-tsc --noEmit 校验）而非伪造运行时测试；
 * 纯行为（isEvidenceUpgradeEligible、错误码区分）用真实运行时测试。
 */
import { describe, expect, it } from 'vitest';
import type { ContentFetchErrorCode } from './errors';
import type { ExtractedContent, EvidenceValidationResult, FetchResult } from './types';
import { isEvidenceUpgradeEligible } from './types';

// ── 测试用构造器 ───────────────────────────────────────────────────────────────

function extracted(): ExtractedContent {
  return { title: 't', plainText: 'p', canonicalUrl: null, contentType: null };
}

function pass(): EvidenceValidationResult {
  return { status: 'PASS', reasonCode: 'jd_complete' };
}

function fail(): EvidenceValidationResult {
  return { status: 'FAIL', reasonCode: 'jd_incomplete_missing_title' };
}

// ── 编译期结构不变量 ───────────────────────────────────────────────────────────

/** K 不在 T 中时为 true；否则为 never（使 `true` 无法赋值，触发 tsc 报错）。 */
type NoKey<T, K extends PropertyKey> = K extends keyof T ? never : true;

function assertNoKey<T, K extends PropertyKey>(_proof: NoKey<T, K>): void {}

type FetchedBranch = Extract<FetchResult, { status: 'FETCHED' }>;

describe('structural invariants — 公共契约不含被禁止字段', () => {
  it('ExtractedContent 不含 rawHtml / raw_content', () => {
    assertNoKey<ExtractedContent, 'rawHtml'>(true);
    assertNoKey<ExtractedContent, 'raw_content'>(true);
  });

  it('FetchResult / FETCHED 分支不含 evidenceLevel / success', () => {
    assertNoKey<FetchResult, 'evidenceLevel'>(true);
    assertNoKey<FetchResult, 'success'>(true);
    assertNoKey<FetchedBranch, 'evidenceLevel'>(true);
  });
});

// ── FETCHED 语义：fetch 成功 ≠ FULL_EVIDENCE ───────────────────────────────────

describe('FetchResult — FETCHED 与证据完整性分离', () => {
  it('FETCHED + 验证 FAIL（证据不完整）→ isEvidenceUpgradeEligible=false', () => {
    const result: FetchResult = { status: 'FETCHED', content: extracted(), validation: fail() };
    expect(result.status).toBe('FETCHED');
    expect(isEvidenceUpgradeEligible(result.validation)).toBe(false);
  });

  it('FETCHED + 验证 PASS → isEvidenceUpgradeEligible=true，但不写 FULL_EVIDENCE', () => {
    const result: FetchResult = { status: 'FETCHED', content: extracted(), validation: pass() };
    expect(result.status).toBe('FETCHED');
    expect(isEvidenceUpgradeEligible(result.validation)).toBe(true);
    // 契约层不存在任何 evidenceLevel 字段（由上方编译期断言保证）。
  });
});

// ── 错误状态可区分 ─────────────────────────────────────────────────────────────

describe('FetchResult — 错误状态可区分', () => {
  it('所有错误码互不相同', () => {
    const codes: ContentFetchErrorCode[] = [
      'BLOCKED_BY_POLICY',
      'NOT_FOUND',
      'TIMEOUT',
      'NETWORK_ERROR',
      'UNSUPPORTED_CONTENT',
      'PARSE_FAILED',
      'REDIRECT_BLOCKED',
      'SSRF_BLOCKED',
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('不同失败分支暴露不同的 status 判别值', () => {
    const timeout: FetchResult = { status: 'TIMEOUT', error: { code: 'TIMEOUT', reason: 'r' } };
    const network: FetchResult = { status: 'NETWORK_ERROR', error: { code: 'NETWORK_ERROR', reason: 'r' } };
    expect(timeout.status).not.toBe(network.status);
  });

  it('FETCHED 与失败分支的 status 可区分', () => {
    const fetched: FetchResult = { status: 'FETCHED', content: extracted(), validation: pass() };
    const blocked: FetchResult = { status: 'BLOCKED_BY_POLICY', error: { code: 'BLOCKED_BY_POLICY', reason: 'r' } };
    expect(fetched.status).not.toBe(blocked.status);
  });
});
