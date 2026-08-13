/**
 * v0.9 Phase 4C-2 — evidenceValidation 测试（保守、false-negative 偏好）。
 */
import { describe, expect, it } from 'vitest';
import { validateEvidence } from './evidenceValidation';
import type { ExtractedContent } from './types';

function content(overrides: Partial<ExtractedContent> = {}): ExtractedContent {
  return {
    title: 'Senior Software Engineer',
    plainText: 'We are looking for a Senior Software Engineer. Responsibilities include building systems. Requirements: 5+ years. Salary competitive.',
    canonicalUrl: null,
    contentType: 'text/html',
    ...overrides,
  };
}

describe('validateEvidence — deny 页（HTTP 200 但实为登录/验证/错误页）', () => {
  it('login wall → FAIL login_wall', () => {
    const r = validateEvidence(content({ title: 'Sign In', plainText: 'Please sign in to continue' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'login_wall' });
  });

  it('captcha → FAIL captcha', () => {
    const r = validateEvidence(content({ title: '人机验证' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'captcha' });
  });

  it('access denied → FAIL access_denied_page', () => {
    const r = validateEvidence(content({ title: 'Access Denied' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'access_denied_page' });
  });

  it('error page → FAIL http_200_error_page', () => {
    const r = validateEvidence(content({ title: 'Page Not Found' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'http_200_error_page' });
  });
});

describe('validateEvidence — 内容不足', () => {
  it('空 title → FAIL missing_title', () => {
    const r = validateEvidence(content({ title: '' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'jd_incomplete_missing_title' });
  });

  it('极短内容 → FAIL insufficient_content', () => {
    const r = validateEvidence(content({ title: 'Engineer', plainText: 'Hi' }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'insufficient_content' });
  });

  it('有文本但无岗位信号（generic homepage）→ FAIL missing_job_signal', () => {
    const longText = 'Welcome to our company. We make great products and serve customers worldwide with passion and dedication. '.repeat(4);
    const r = validateEvidence(content({ title: 'Acme Corp', plainText: longText }));
    expect(r).toEqual({ status: 'FAIL', reasonCode: 'jd_incomplete_missing_job_signal' });
  });
});

describe('validateEvidence — 完整 JD', () => {
  it('完整 JD → PASS', () => {
    const r = validateEvidence(content());
    expect(r).toEqual({ status: 'PASS', reasonCode: 'jd_complete' });
  });

  it('Salary 非强制（无薪资字段仍可 PASS）', () => {
    const r = validateEvidence(content({
      plainText: 'We are hiring an engineer to join our team. Responsibilities: design and build scalable software systems and collaborate with the team. Requirements: several years of relevant experience and strong problem-solving skills.',
    }));
    expect(r.status).toBe('PASS');
  });
});
