/**
 * v0.9 Phase 4C-2 — Evidence Validation（保守、false-negative 偏好）。
 *
 * 设计依据：Phase 4C-2 Implementation Scope Lock v3。
 *
 * 核心语义：
 *   page has text != sufficient job evidence。
 *   PASS 只表示「eligible for future evidence_upgrade」，绝不写 FULL_EVIDENCE。
 *   Salary 不是 PASS 强制项。
 *
 * 判定顺序（保守）：
 *   1. 空 title → FAIL jd_incomplete_missing_title
 *   2. title 命中 deny 页特征（login wall / captcha / access denied / error page）→ FAIL
 *   3. plainText 过短 → FAIL insufficient_content
 *   4. 无岗位信号 → FAIL jd_incomplete_missing_job_signal
 *   5. 否则 PASS jd_complete
 *
 * 本模块只接收已成功解码 + normalization 的 plainText，不做任何 DB / 分析 / 写库。
 */

import type { EvidenceValidationResult, ExtractedContent } from './types';

/** 岗位正文最小长度（实现级启发式默认，保守）。 */
const MIN_PLAIN_TEXT_LENGTH = 120;

/** title 级 deny 页特征（页面标题最能反映「这是登录/验证/错误页」而非 JD）。 */
const TITLE_DENY_PATTERNS: Array<{ reasonCode: string; pattern: RegExp }> = [
  { reasonCode: 'login_wall', pattern: /(log\s*in|sign\s*in|登录|登入|账号登录|密码登录)/i },
  { reasonCode: 'captcha', pattern: /(captcha|验证码|人机验证|recaptcha|just\s*a\s*moment)/i },
  { reasonCode: 'access_denied_page', pattern: /(access\s*denied|forbidden|无权限|无权访问|拒绝访问)/i },
  { reasonCode: 'http_200_error_page', pattern: /(page\s*not\s*found|not\s*found|404|error\s*page|错误页面|出错了)/i },
];

/** 岗位信号 token（中英文 JD 常见结构词）。 */
const JOB_SIGNAL_PATTERN =
  /(岗位|职位|工作职责|任职要求|岗位要求|招聘|职责描述|responsibilities|requirements|qualifications|job\s*description|\bjd\b|salary|薪资|福利|about\s*the\s*role|what\s*you.?ll\s*do)/i;

export function validateEvidence(content: ExtractedContent): EvidenceValidationResult {
  const title = content.title.trim();
  const text = content.plainText.trim();

  if (title === '') {
    return { status: 'FAIL', reasonCode: 'jd_incomplete_missing_title' };
  }

  for (const d of TITLE_DENY_PATTERNS) {
    if (d.pattern.test(title)) {
      return { status: 'FAIL', reasonCode: d.reasonCode };
    }
  }

  if (text.length < MIN_PLAIN_TEXT_LENGTH) {
    return { status: 'FAIL', reasonCode: 'insufficient_content' };
  }

  if (!JOB_SIGNAL_PATTERN.test(`${title}\n${text}`)) {
    return { status: 'FAIL', reasonCode: 'jd_incomplete_missing_job_signal' };
  }

  return { status: 'PASS', reasonCode: 'jd_complete' };
}
